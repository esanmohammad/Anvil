/**
 * Install the SandboxExecWrapper at dashboard boot — Phase P3.
 *
 * Bridges agent-core's process slot (`setSandboxExecWrapper`) to
 * core-pipeline's `wrapSandboxExec` + `buildHandleStateHasher`. The
 * wrapper closes over both so the bash tool dispatch (in agent-core's
 * builtin.ts:runBash) doesn't need to import core-pipeline.
 *
 * Effect: when a stage runs through `pipeline-stages.ts:withSandboxForStage`,
 * AND the agent's bash tool is dispatched within the resulting
 * StepContext, the exec records under a `sandbox:exec:<runId>:<stage>:<idx>:<hash>`
 * idempotency key bound to a content-addressed state hash of the
 * sandbox's workdir. Replay returns the recorded SandboxExecResult
 * instantly when the state hash matches; otherwise throws
 * SandboxDeterminismViolationError.
 */
export declare function installSandboxExecWrapper(): void;
/** Test-only — clear hashers between cases. */
export declare function __clearSandboxExecHashersForTests(): void;
//# sourceMappingURL=install-exec-wrapper.d.ts.map