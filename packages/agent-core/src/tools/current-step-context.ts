/**
 * Process-level slot for the active `StepContext` so deep-stack tool
 * calls (the agent loop dispatching `web_search`/`web_fetch`/etc. via
 * the `WebToolExecutor`) can opt into durable wrapping without
 * threading the context through every layer.
 *
 * The dashboard's pipeline-stages layer sets this slot at the start of
 * each spawn that needs durable web/browser effects, and clears it on
 * exit. The web tool executor reads it in `execute()` and wraps the
 * tool call in `ctx.effect(...)` when present.
 *
 * Storage is intentionally a plain global (not AsyncLocalStorage) —
 * stages are serial within one process, and the tool executor's
 * promise chain rides one tick of the event loop. AsyncLocalStorage
 * is overkill for the actual concurrency profile and would force
 * every adapter through a context.run() wrapper.
 */

// Loose typing — agent-core can't import core-pipeline (circular). The
// dashboard supplies the full StepContext shape; the executor accesses
// `effect` only. Cast at the call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StepContextLike = any;

let _ctx: StepContextLike | undefined;

export function setCurrentStepContext(ctx: StepContextLike | undefined): void {
  _ctx = ctx;
}

export function getCurrentStepContext(): StepContextLike | undefined {
  return _ctx;
}
