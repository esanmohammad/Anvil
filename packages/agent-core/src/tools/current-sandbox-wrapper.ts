/**
 * Process-level slot for a sandbox-exec wrapper — Phase P3.
 *
 * The dashboard installs a function at boot that closes over
 * `wrapSandboxExec` + `buildHandleStateHasher` from core-pipeline.
 * agent-core's BuiltinToolExecutor.runBash calls the wrapper when
 * BOTH a sandbox handle AND a step context are in scope, so durable
 * replay records the exec under a state-hash-bounded idempotency key.
 *
 * The slot pattern avoids a core-pipeline import in agent-core
 * (would be a circular dep). Mirrors current-step-context.ts +
 * current-sandbox-handle.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SandboxExecArgsLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SandboxExecResultLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StepContextLike = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SandboxHandleLike = any;

/**
 * Wrapper signature. Implementations should:
 *   - Compute a state hash via `buildHandleStateHasher(handle)` if
 *     desired (or pass undefined for non-deterministic wraps).
 *   - Call `wrapSandboxExec(ctx, args, execArgs, fn)`.
 *   - Return the SandboxExecResult.
 */
export type SandboxExecWrapper = (opts: {
  ctx: StepContextLike;
  handle: SandboxHandleLike;
  execArgs: SandboxExecArgsLike;
  /** Monotonic idx within the stage — caller increments per call. */
  idx: number;
  /** The actual exec to wrap. */
  fn: () => Promise<SandboxExecResultLike>;
}) => Promise<SandboxExecResultLike>;

let _wrapper: SandboxExecWrapper | undefined;

/** Install the wrapper at boot. Idempotent — replaces any prior. */
export function setSandboxExecWrapper(w: SandboxExecWrapper | undefined): void {
  _wrapper = w;
}

export function getSandboxExecWrapper(): SandboxExecWrapper | undefined {
  return _wrapper;
}
