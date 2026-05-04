/**
 * `clarify-stage` — Phase 4f.4 of the dashboard consolidation.
 *
 * Lifts the full 3-phase orchestration that
 * `pipeline-runner.ts:runClarifyStage()` performs:
 *
 *   - Phase A (explore):   spawn the clarifier agent, wait for the
 *                          explore-phase output (raw markdown of questions).
 *   - Phase B (Q&A loop):  parse questions, ask each one through the
 *                          dashboard's WebSocket userMessage path, collect
 *                          answers. Loop bails on cancellation, empty
 *                          answer, or resolver rejection.
 *   - Phase C (synthesize): when at least one Q&A pair landed, resume the
 *                          SAME agent via `agentManager.sendInput` with
 *                          the synthesis prompt and wait for it to emit
 *                          `CLARIFICATION.md`.
 *
 * Phase 4e's `clarify.step.ts` already lifts Phase B in isolation as a
 * `Step<string, ClarifyResult>`; this module composes it with the
 * agent-spawn lifecycle so `pipeline-runner.runClarifyStage` can shrink
 * to a thin closure over the helper. Phase 4f.7 will register the
 * Step factory exported here so `Pipeline.run()` becomes the orchestrator.
 *
 * The dashboard's WebSocket event vocabulary (D10 — 133 messages
 * unchanged) is preserved via callbacks on the helper's options:
 * `onClarifyQuestion`, `onWaitingForInput`, `onUserInput`,
 * `onClarifyAck`, `setWaitingState`. The helper does NOT speak WS
 * directly — pipeline-runner wires those callbacks today.
 */
import { spawnAndWait, waitForAgent } from './agent-spawner.js';
import { buildClarifySynthesisPrompt, formatQAPairs, parseClarifyQuestions, } from './clarify.step.js';
const CLARIFY_DISALLOWED_TOOLS = [
    'Write', 'Edit', 'NotebookEdit', 'Bash',
];
/**
 * Run the dashboard's interactive clarify stage end-to-end. Returns
 * the final artifact + accumulated cost. The caller is expected to
 * surface the dashboard state mutations (status='waiting' /
 * waitingForInput=true) via the supplied `setWaitingState` callback.
 */
export async function runClarifyForProject(opts) {
    // Phase A — explore.
    const explore = await spawnAndWait({
        agentManager: opts.agentManager,
        spec: {
            name: `clarifier-${opts.project}`,
            persona: 'clarifier',
            project: opts.project,
            stage: 'clarify',
            prompt: opts.explorePrompt,
            model: opts.model,
            cwd: opts.workspaceDir,
            projectPrompt: opts.projectPrompt,
            permissionMode: 'bypassPermissions',
            disallowedTools: [...CLARIFY_DISALLOWED_TOOLS],
            allowedTools: opts.allowedTools,
            maxOutputTokens: opts.maxOutputTokens,
        },
        isCancelled: opts.isCancelled,
        onSpawn: opts.onAgentSpawned,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
    });
    let totalCost = explore.cost;
    // Phase B — Q&A loop.
    const parsed = parseClarifyQuestions(explore.artifact);
    const trimmedArtifact = explore.artifact.trim();
    // Three-tier fallback:
    //   1. Parsed numbered list — happy path.
    //   2. Non-empty unparsed output — legacy: treat the whole artifact
    //      as one question (still useful, e.g. model wrote prose).
    //   3. Empty artifact — model spent its turns on tool reads /
    //      thinking but never emitted final text. Surface a clear
    //      catch-all question so the user can drive the run forward
    //      instead of seeing a blank Q1.
    let questions;
    if (parsed.length > 0) {
        questions = parsed;
    }
    else if (trimmedArtifact.length > 0) {
        questions = [trimmedArtifact];
    }
    else {
        console.warn(`[clarify] model produced no parseable text for ${opts.project}; ` +
            `agentId=${explore.agentId}. Falling back to a generic clarifier question.`);
        questions = [
            'I could not generate clarifying questions automatically. ' +
                'Please describe the feature in more detail — scope, constraints, ' +
                'edge cases, and any acceptance criteria you have in mind.',
        ];
    }
    const qaPairs = [];
    let cancelled = false;
    for (let qi = 0; qi < questions.length; qi += 1) {
        if (opts.isCancelled()) {
            cancelled = true;
            break;
        }
        const question = questions[qi];
        opts.onClarifyQuestion?.(qi, questions.length, question);
        opts.onWaitingForInput?.(explore.agentId);
        let answer;
        try {
            answer = await opts.inputResolver(question, qi, questions.length);
        }
        catch {
            // Resolver rejection is treated as cancellation — same as legacy
            // where the readline reject-on-cancel path bails out of the loop.
            cancelled = true;
            break;
        }
        if (opts.isCancelled() || !answer) {
            cancelled = true;
            break;
        }
        qaPairs.push({ question, answer });
        opts.onAnswerReceived?.(answer);
        opts.onClarifyAck?.(qi, questions.length, qi < questions.length - 1);
    }
    // Phase C — synthesize (only if at least one Q&A pair landed AND we
    // weren't cancelled mid-loop).
    if (cancelled || qaPairs.length === 0) {
        return {
            artifact: explore.artifact,
            cost: totalCost,
            agentId: explore.agentId,
            questions,
            qaPairs,
            synthesizeRan: false,
            cancelled,
            inputTokens: explore.inputTokens,
            outputTokens: explore.outputTokens,
            cacheReadTokens: explore.cacheReadTokens,
            cacheWriteTokens: explore.cacheWriteTokens,
        };
    }
    opts.onSynthesizeStart?.();
    const synthesisPrompt = buildClarifySynthesisPrompt(formatQAPairs(qaPairs));
    opts.agentManager.sendInput(explore.agentId, synthesisPrompt);
    const synthesize = await waitForAgent({
        agentId: explore.agentId,
        agentManager: opts.agentManager,
        isCancelled: opts.isCancelled,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
    });
    totalCost += synthesize.cost;
    return {
        artifact: synthesize.artifact || explore.artifact,
        cost: totalCost,
        agentId: explore.agentId,
        questions,
        qaPairs,
        synthesizeRan: true,
        cancelled: false,
        inputTokens: explore.inputTokens + synthesize.inputTokens,
        outputTokens: explore.outputTokens + synthesize.outputTokens,
        cacheReadTokens: explore.cacheReadTokens + synthesize.cacheReadTokens,
        cacheWriteTokens: explore.cacheWriteTokens + synthesize.cacheWriteTokens,
    };
}
/**
 * Step factory for the full clarify stage (explore + Q&A + synthesize).
 * NOT auto-registered — Phase 4f.7 wires it once `Pipeline.run()` becomes
 * the orchestrator.
 */
export function createClarifyStageStep(opts) {
    const id = opts.id ?? 'clarify-stage';
    return {
        id,
        name: 'Clarify stage (explore + Q&A + synthesize)',
        parallelism: 'serial',
        async run(ctx) {
            const isCancelled = opts.isCancelled
                ? () => opts.isCancelled(ctx)
                : () => ctx.signal.aborted;
            return runClarifyForProject({
                agentManager: opts.agentManager,
                project: opts.project,
                workspaceDir: opts.workspaceDir,
                model: opts.model,
                maxOutputTokens: opts.maxOutputTokens,
                explorePrompt: opts.buildExplorePrompt(),
                projectPrompt: opts.buildProjectPrompt(),
                inputResolver: opts.inputResolver,
                isCancelled,
                onAgentSpawned: opts.onAgentSpawned,
                onTruncation: opts.onTruncation,
                onClarifyQuestion: opts.onClarifyQuestion,
                onWaitingForInput: opts.onWaitingForInput,
                onAnswerReceived: opts.onAnswerReceived,
                onClarifyAck: opts.onClarifyAck,
                onSynthesizeStart: opts.onSynthesizeStart,
                pollIntervalMs: opts.pollIntervalMs,
                sleep: opts.sleep,
            });
        },
    };
}
//# sourceMappingURL=clarify-stage.step.js.map