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
import { type ClarifyQAPair } from './clarify.step.js';
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
    /** Per-stage allow list for tool names — drives BuiltinToolExecutor for
     *  agentic non-Claude adapters. Clarify defaults to read-only. */
    allowedTools?: string[];
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
    /** Aggregate input tokens across explore + synthesize phases. */
    inputTokens: number;
    /** Aggregate output tokens across explore + synthesize phases. */
    outputTokens: number;
    /** Aggregate cache READ tokens (Anthropic prompt cache hits). */
    cacheReadTokens: number;
    /** Aggregate cache WRITE tokens (first-call cache provisioning). */
    cacheWriteTokens: number;
}
/**
 * Run the dashboard's interactive clarify stage end-to-end. Returns
 * the final artifact + accumulated cost. The caller is expected to
 * surface the dashboard state mutations (status='waiting' /
 * waitingForInput=true) via the supplied `setWaitingState` callback.
 */
export declare function runClarifyForProject(opts: RunClarifyForProjectOptions): Promise<RunClarifyForProjectResult>;
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
export declare function createClarifyStageStep(opts: ClarifyStageStepOptions): Step<unknown, RunClarifyForProjectResult>;
//# sourceMappingURL=clarify-stage.step.d.ts.map