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
import type { Step } from '@anvil/core-pipeline';
export declare const CLARIFY_QA_ARTIFACT_ID = "CLARIFY-QA.json";
export interface ClarifyQAPair {
    question: string;
    answer: string;
}
export interface ClarifyResult {
    /** Original questions parsed from the explore-phase output. */
    questions: string[];
    /** Q&A pairs collected from the user (may be shorter than `questions` if cancelled). */
    qaPairs: ClarifyQAPair[];
    /** Prompt suffix the synthesis Step sends to the resumed agent. */
    synthesisPrompt: string;
    /** True when the loop terminated via abort signal or empty resolver reply. */
    cancelled: boolean;
}
export interface ClarifyStepOptions {
    id?: string;
    /**
     * Resolves each question to the user's reply. Required — the dashboard
     * supplies the WS userMessage path; tests can supply a stub. An empty
     * string is treated as "user cancelled" and stops the loop.
     */
    inputResolver: (question: string, qIndex: number, qTotal: number) => Promise<string>;
    /**
     * Optional event hook so the dashboard can broadcast question/answer
     * pairs over its existing 133-message WS surface (D10 invariant). If
     * omitted, only the ctx.bus events fire.
     */
    onEvent?: (event: ClarifyEvent) => void;
}
export type ClarifyEvent = {
    type: 'question';
    questionIndex: number;
    totalQuestions: number;
    question: string;
} | {
    type: 'answer';
    questionIndex: number;
    answer: string;
} | {
    type: 'complete';
    qaPairs: ClarifyQAPair[];
};
/**
 * Parse questions out of the clarifier agent's exploration output.
 * Lifted verbatim from `pipeline-runner.ts:parseQuestions()` so the
 * dedup + length filter behavior matches byte-for-byte.
 */
export declare function parseClarifyQuestions(output: string): string[];
/**
 * Format Q&A pairs into the body the synthesis prompt expects.
 * Mirrors `pipeline-runner.ts:runClarifyStage()` qaText assembly.
 */
export declare function formatQAPairs(qaPairs: ClarifyQAPair[]): string;
/**
 * Build the synthesis prompt the resumed clarifier agent receives after
 * the user has answered every question. Lifted verbatim from
 * `pipeline-runner.ts:runClarifyStage()` so cache-key parity with the
 * legacy holds. Exported for Phase 4f.4 (`runClarifyForProject`) which
 * orchestrates the explore → QA → synthesize round-trip.
 */
export declare function buildClarifySynthesisPrompt(qaText: string): string;
/**
 * Build the clarify Q&A Step. The Step's input is the explore-phase
 * output (raw markdown emitted by the clarifier agent). Output is a
 * `ClarifyResult` carrying the qaPairs + synthesis prompt.
 */
export declare function createClarifyStep(opts: ClarifyStepOptions): Step<string, ClarifyResult>;
//# sourceMappingURL=clarify.step.d.ts.map