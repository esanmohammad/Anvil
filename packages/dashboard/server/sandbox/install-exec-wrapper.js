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
import { setSandboxExecWrapper } from '@esankhan3/anvil-agent-core';
import { wrapSandboxExec, buildHandleStateHasher, } from '@esankhan3/anvil-core-pipeline';
/** Track per-(runId, stage) hashers so successive execs in the same
 *  stage share a StatHashCache (perf — re-hashing the workdir on
 *  every bash call would be expensive). */
const hashers = new Map();
export function installSandboxExecWrapper() {
    setSandboxExecWrapper(async ({ ctx, handle, execArgs, idx, fn }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = ctx;
        const runId = c?.runId ?? 'unknown';
        const stage = c?.stage ?? 'unknown';
        const handleKey = `${runId}:${stage}:${handle?.id ?? 'unknown'}`;
        let hasher = hashers.get(handleKey);
        if (!hasher) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            hasher = buildHandleStateHasher(handle);
            hashers.set(handleKey, hasher);
        }
        return wrapSandboxExec(ctx, {
            runId,
            stage,
            idx,
            sandboxStateHash: hasher,
        }, execArgs, fn);
    });
}
/** Test-only — clear hashers between cases. */
export function __clearSandboxExecHashersForTests() {
    hashers.clear();
}
//# sourceMappingURL=install-exec-wrapper.js.map