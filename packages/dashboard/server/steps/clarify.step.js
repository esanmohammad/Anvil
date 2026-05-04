/**
 * `clarify.step` — Q&A orchestration Step for the dashboard's interactive
 * clarify stage.
 *
 * Phase 4e of the dashboard consolidation. Lifts the **deterministic** part
 * of `pipeline-runner.ts:runClarifyStage()` — parsing questions out of the
 * explore-phase output, dispatching them through the dashboard's WebSocket
 * userMessage path one at a time, and assembling the synthesis prompt — into
 * a `Step<string, ClarifyResult>`.
 *
 * What this Step does NOT do:
 *   - Spawn the explore-phase agent (Phase 4f's per-stage Step does that)
 *   - Run the synthesis LLM call (Phase 4f does that, consuming the
 *     `synthesisPrompt` field of `ClarifyResult`)
 *
 * What it DOES:
 *   - parseClarifyQuestions(input)  — same logic as parseQuestions()
 *   - For each question, awaits a user reply via the supplied
 *     `inputResolver` and emits Q/A bus events so the dashboard's WS
 *     client can render them. The resolver shape matches
 *     `DashboardStepRegistryDeps.clarifyInputResolver`.
 *   - Aborts cleanly on `ctx.signal` so cancellation propagates
 *   - Returns `{ qaPairs, synthesisPrompt }` for downstream consumers
 *
 * Bus events (fire-and-forget):
 *   - `clarify:question`  payload `{ questionIndex, totalQuestions, question }`
 *   - `clarify:answer`    payload `{ questionIndex, answer }`
 *   - `clarify:complete`  payload `{ qaPairs }`
 *
 * These are NOT canonical `StepHookPoint`s — they're emitted via
 * `ctx.bus.emitFireAndForget` with hook `'artifact:emitted'` and a typed
 * payload, so existing core-pipeline subscribers don't need new hook
 * support. Phase 4f will land first-class hook points if the dashboard
 * UI needs them.
 */
export const CLARIFY_QA_ARTIFACT_ID = 'CLARIFY-QA.json';
/**
 * Parse questions out of the clarifier agent's exploration output.
 * Lifted verbatim from `pipeline-runner.ts:parseQuestions()` so the
 * dedup + length filter behavior matches byte-for-byte.
 */
export function parseClarifyQuestions(output) {
    const lines = output.split('\n');
    const questions = [];
    let current = '';
    for (const line of lines) {
        const isNewQ = /^\s*\d+[.)]\s+/.test(line);
        if (isNewQ) {
            if (current.trim())
                questions.push(current.trim());
            current = line.replace(/^\s*\d+[.)]\s+/, '');
        }
        else if (current) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.toLowerCase().startsWith('please answer')) {
                current += '\n' + line;
            }
        }
    }
    if (current.trim())
        questions.push(current.trim());
    const seen = new Set();
    return questions.filter((q) => {
        if (q.length <= 10)
            return false;
        const normalized = q.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (seen.has(normalized))
            return false;
        seen.add(normalized);
        return true;
    });
}
/**
 * Format Q&A pairs into the body the synthesis prompt expects.
 * Mirrors `pipeline-runner.ts:runClarifyStage()` qaText assembly.
 */
export function formatQAPairs(qaPairs) {
    return qaPairs
        .map((qa, i) => `**Q${i + 1}**: ${qa.question}\n**A${i + 1}**: ${qa.answer}`)
        .join('\n\n');
}
/**
 * Build the synthesis prompt the resumed clarifier agent receives after
 * the user has answered every question. Lifted verbatim from
 * `pipeline-runner.ts:runClarifyStage()` so cache-key parity with the
 * legacy holds. Exported for Phase 4f.4 (`runClarifyForProject`) which
 * orchestrates the explore → QA → synthesize round-trip.
 */
export function buildClarifySynthesisPrompt(qaText) {
    return `Here are the clarifying questions and the user's answers:\n\n${qaText}\n\n`
        + 'Now synthesize a CLARIFICATION.md document that combines the questions, '
        + "answers, and your codebase understanding into clear context for the next "
        + 'stages. Output ONLY the markdown content.';
}
const SYNTHESIS_PROMPT_TEMPLATE = (qaText) => buildClarifySynthesisPrompt(qaText);
/**
 * Build the clarify Q&A Step. The Step's input is the explore-phase
 * output (raw markdown emitted by the clarifier agent). Output is a
 * `ClarifyResult` carrying the qaPairs + synthesis prompt.
 */
export function createClarifyStep(opts) {
    const id = opts.id ?? 'clarify-qa';
    return {
        id,
        name: 'Clarify Q&A',
        parallelism: 'serial',
        async run(ctx) {
            const exploreOutput = typeof ctx.input === 'string' ? ctx.input : '';
            const parsed = parseClarifyQuestions(exploreOutput);
            // Mirror the legacy fallback: when no questions parse out, treat the
            // entire output as a single block. Only do this when the output is
            // non-empty so an empty input doesn't trigger a meaningless prompt.
            const questions = parsed.length > 0
                ? parsed
                : (exploreOutput.trim() ? [exploreOutput] : []);
            const qaPairs = [];
            let cancelled = false;
            for (let i = 0; i < questions.length; i += 1) {
                if (ctx.signal.aborted) {
                    cancelled = true;
                    break;
                }
                const question = questions[i];
                opts.onEvent?.({
                    type: 'question',
                    questionIndex: i,
                    totalQuestions: questions.length,
                    question,
                });
                let answer;
                try {
                    answer = await opts.inputResolver(question, i, questions.length);
                }
                catch (error) {
                    // Resolver rejection is treated as cancellation — same as legacy
                    // runClarifyStage where the readline path's reject-on-cancel
                    // breaks the loop without a synthesis call.
                    cancelled = true;
                    ctx.bus.emitFireAndForget({
                        hook: 'artifact:emitted',
                        runId: ctx.runId,
                        stepId: id,
                        ts: new Date().toISOString(),
                        payload: { artifactId: 'clarify:resolver-error', data: { error: String(error) } },
                    });
                    break;
                }
                if (!answer) {
                    cancelled = true;
                    break;
                }
                qaPairs.push({ question, answer });
                opts.onEvent?.({ type: 'answer', questionIndex: i, answer });
            }
            const synthesisPrompt = qaPairs.length > 0
                ? SYNTHESIS_PROMPT_TEMPLATE(formatQAPairs(qaPairs))
                : '';
            const result = {
                questions,
                qaPairs,
                synthesisPrompt,
                cancelled,
            };
            opts.onEvent?.({ type: 'complete', qaPairs });
            ctx.emit(CLARIFY_QA_ARTIFACT_ID, result);
            return result;
        },
    };
}
//# sourceMappingURL=clarify.step.js.map