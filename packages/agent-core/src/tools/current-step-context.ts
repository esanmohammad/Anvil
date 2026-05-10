/**
 * Active `StepContext` slot for deep-stack tool calls (web_search /
 * web_fetch / browser_* / computer_use via the `WebToolExecutor`).
 *
 * Backed by `AsyncLocalStorage` so per-repo fanout — stages running
 * concurrently — each see their own ctx without trampling the global.
 * Falls back to a synchronous global when callers use the legacy
 * `setCurrentStepContext` pattern (set on entry, clear on exit).
 *
 * Resolution order:
 *   1. ALS store (preferred — concurrency-safe).
 *   2. Synchronous global (legacy `setCurrentStepContext`).
 *   3. `undefined` — non-durable mode.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// Loose typing — agent-core can't import core-pipeline (circular). The
// dashboard supplies the full StepContext shape; the executor accesses
// `effect` / `runId` only. Cast at the call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StepContextLike = any;

const als = new AsyncLocalStorage<StepContextLike>();
let _legacyCtx: StepContextLike | undefined;

/**
 * Run `fn` with `ctx` as the active step context for the duration of
 * the async chain. Preferred over `setCurrentStepContext` for
 * concurrent stages (per-repo fanout).
 */
export function withCurrentStepContext<T>(ctx: StepContextLike, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/**
 * @deprecated Use `withCurrentStepContext` for new code.
 *
 * Synchronous setter retained for the legacy `runOneStage` set/clear
 * pattern. Doesn't propagate across `await` boundaries the way ALS
 * does, but works fine for serial pipeline stages.
 */
export function setCurrentStepContext(ctx: StepContextLike | undefined): void {
  _legacyCtx = ctx;
  if (ctx !== undefined) {
    // Best-effort: register on the current async chain so synchronous
    // descendants pick it up alongside the ALS-aware path.
    als.enterWith(ctx);
  }
}

export function getCurrentStepContext(): StepContextLike | undefined {
  return als.getStore() ?? _legacyCtx;
}
