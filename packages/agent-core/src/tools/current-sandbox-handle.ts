/**
 * Active sandbox handle slot for builtin tool calls.
 *
 * Mirrors `current-step-context.ts` — a process-level + ALS-backed
 * slot consumed by `BuiltinToolExecutor.runBash`. When a stage has
 * acquired a sandbox, set the handle here; the bash tool then
 * dispatches `handle.exec(...)` instead of host `child_process.spawn`.
 *
 * Phase S follow-up #2 — minimal seam. Future work can extend this
 * to route read/write/edit through the same handle so tool calls
 * land inside the overlay rather than on the host workdir.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SandboxHandleLike = any;

const als = new AsyncLocalStorage<SandboxHandleLike>();
let _legacyHandle: SandboxHandleLike | undefined;

/**
 * Run `fn` with `handle` as the active sandbox handle. Preferred for
 * concurrent stages (per-repo fanout) — each sees its own handle.
 */
export function withCurrentSandboxHandle<T>(
  handle: SandboxHandleLike,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(handle, fn);
}

/**
 * @deprecated Use `withCurrentSandboxHandle` for concurrent code.
 * Synchronous setter retained for the simple set/clear pattern.
 */
export function setCurrentSandboxHandle(handle: SandboxHandleLike | undefined): void {
  _legacyHandle = handle;
  if (handle !== undefined) {
    als.enterWith(handle);
  }
}

export function getCurrentSandboxHandle(): SandboxHandleLike | undefined {
  return als.getStore() ?? _legacyHandle;
}
