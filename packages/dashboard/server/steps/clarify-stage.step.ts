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
import {
  buildClarifySynthesisPrompt,
  formatQAPairs,
  parseClarifyQuestions,
  type ClarifyQAPair,
} from './clarify.step.js';
import type { AgentManager } from '@anvil/agent-core';
import type { Step, StepContext } from '@anvil/core-pipeline';

export interface RunClarifyForProjectOptions {
  agentManager: AgentManager;
  /** Project slug — forwarded to the spawn config. */
  project: string;
  /** Working directory for the explore-phase agent (project workspace). */
  workspaceDir: string;
  /** Resolved model id for the clarify stage. */
  model: string;
  /** Optional output-token ceiling. */
  maxOutputTokens?: number;
  /** Pre-built explore-phase user prompt. */
  explorePrompt: string;
  /** Pre-built per-stage project (system) prompt. */
  projectPrompt: string;
  /**
   * Resolves each parsed question to the user's reply. Required —
   * pipeline-runner wires this to its WebSocket userMessage path; tests
   * can supply a stub. An empty string is treated as "user cancelled"
   * and stops the loop.
   */
  inputResolver: (question: string, qIndex: number, qTotal: number) => Promise<string>;
  /** Returns true when the run has been cancelled — checked before each question. */
  isCancelled: () => boolean;
  /**
   * Called once with the freshly-spawned explore agent id. Caller is
   * expected to set `state.stages[index].agentId` and broadcast state.
   * Same agent id is used for the synthesize phase (sendInput resumes it).
   */
  onAgentSpawned?: (agentId: string) => void;
  /** Called when the agent's stop_reason is `max_tokens`. */
  onTruncation?: (agentName: string, outputTokens: number) => void;
  /** Called as each question is dispatched (legacy `clarify-question` event). */
  onClarifyQuestion?: (questionIndex: number, totalQuestions: number, question: string) => void;
  /**
   * Called immediately before awaiting the user's reply. The legacy sets
   * `state.stages[i].status='waiting'` + `state.status='waiting'` +
   * `state.waitingForInput=true` and broadcasts before emitting
   * `waiting-for-input`.
   */
  onWaitingForInput?: (agentId: string) => void;
  /**
   * Called after recording a non-empty answer. The legacy clears
   * `state.waitingForInput=false` and broadcasts (without touching stage
   * status — it stays `'waiting'` between questions until Phase C).
   */
  onAnswerReceived?: (answer: string) => void;
  /** Called after `onAnswerReceived`, mirroring the legacy `clarify-ack`. */
  onClarifyAck?: (questionIndex: number, totalQuestions: number, hasMore: boolean) => void;
  /**
   * Called once before the synthesize phase runs. The legacy sets
   * `state.stages[i].status='running'` + `state.status='running'` +
   * `state.waitingForInput=false` and broadcasts. Skipped when the loop
   * bailed without collecting any Q&A pairs.
   */
  onSynthesizeStart?: () => void;
  /** Test seams — forwarded to spawnAndWait + waitForAgent. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunClarifyForProjectResult {
  /** Final artifact — synthesize output if it ran, else the explore output. */
  artifact: string;
  /** Total cost across explore + synthesize phases. */
  cost: number;
  /** Agent id used for both phases (sendInput resumes the same agent). */
  agentId: string;
  /** Questions parsed from the explore-phase output. */
  questions: string[];
  /** Q&A pairs collected from the user. */
  qaPairs: ClarifyQAPair[];
  /** True when the synthesize phase ran (qaPairs non-empty + not cancelled). */
  synthesizeRan: boolean;
  /** True when the loop terminated via cancellation or empty answer. */
  cancelled: boolean;
}

const CLARIFY_DISALLOWED_TOOLS: readonly string[] = [
  'Write', 'Edit', 'NotebookEdit', 'Bash',
];

/**
 * Run the dashboard's interactive clarify stage end-to-end. Returns
 * the final artifact + accumulated cost. The caller is expected to
 * surface the dashboard state mutations (status='waiting' /
 * waitingForInput=true) via the supplied `setWaitingState` callback.
 */
export async function runClarifyForProject(
  opts: RunClarifyForProjectOptions,
): Promise<RunClarifyForProjectResult> {
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
  // Mirror the legacy fallback: when no questions parse out, treat the
  // entire explore output as a single block.
  const questions = parsed.length > 0 ? parsed : [explore.artifact];

  const qaPairs: ClarifyQAPair[] = [];
  let cancelled = false;

  for (let qi = 0; qi < questions.length; qi += 1) {
    if (opts.isCancelled()) {
      cancelled = true;
      break;
    }

    const question = questions[qi];
    opts.onClarifyQuestion?.(qi, questions.length, question);
    opts.onWaitingForInput?.(explore.agentId);

    let answer: string;
    try {
      answer = await opts.inputResolver(question, qi, questions.length);
    } catch {
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
  };
}

export interface ClarifyStageStepOptions {
  /** Optional Step id override; defaults to `clarify-stage`. */
  id?: string;
  agentManager: AgentManager;
  project: string;
  workspaceDir: string;
  model: string;
  maxOutputTokens?: number;
  /** Builds the explore-phase user prompt for the project. */
  buildExplorePrompt: () => string;
  /** Builds the project (system) prompt for the clarify stage. */
  buildProjectPrompt: () => string;
  inputResolver: (question: string, qIndex: number, qTotal: number) => Promise<string>;
  onAgentSpawned?: (agentId: string) => void;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  onClarifyQuestion?: (questionIndex: number, totalQuestions: number, question: string) => void;
  onWaitingForInput?: (agentId: string) => void;
  onAnswerReceived?: (answer: string) => void;
  onClarifyAck?: (questionIndex: number, totalQuestions: number, hasMore: boolean) => void;
  onSynthesizeStart?: () => void;
  /**
   * Optional cancellation predicate — defaults to checking
   * `ctx.signal.aborted`. Override when the caller has its own cancel
   * flag (e.g. PipelineRunner.cancelled).
   */
  isCancelled?: (ctx: StepContext<unknown>) => boolean;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Step factory for the full clarify stage (explore + Q&A + synthesize).
 * NOT auto-registered — Phase 4f.7 wires it once `Pipeline.run()` becomes
 * the orchestrator.
 */
export function createClarifyStageStep(
  opts: ClarifyStageStepOptions,
): Step<unknown, RunClarifyForProjectResult> {
  const id = opts.id ?? 'clarify-stage';

  return {
    id,
    name: 'Clarify stage (explore + Q&A + synthesize)',
    parallelism: 'serial',
    async run(ctx: StepContext<unknown>): Promise<RunClarifyForProjectResult> {
      const isCancelled = opts.isCancelled
        ? () => opts.isCancelled!(ctx)
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
