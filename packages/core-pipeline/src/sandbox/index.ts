/**
 * Sandbox-runner barrel re-exports.
 *
 * Public surface for the sandbox isolation layer (S0-S13 in
 * `docs/sandbox-isolation-plan.md`). Concrete runtimes (`docker`,
 * `firecracker`, `gvisor`) live in `@anvil-dev/dashboard/server/sandbox/`
 * because they require runtime-specific binaries; only the contract,
 * the per-stage policy, and the `none` runner live here.
 */

export * from './types.js';
export {
  NoneSandboxHandle,
  NoneSandboxRunner,
} from './none-runner.js';
export {
  registerSandboxRunner,
  isSandboxRunnerRegistered,
  getSandboxRunner,
  shutdownAllSandboxRunners,
  __resetSandboxRegistryForTests,
} from './runner-registry.js';
export {
  StatHashCache,
  hashWorkdir,
  DEFAULT_HASH_SKIP,
  type WorkdirHash,
  type HashOptions,
} from './state-hash.js';
export {
  sandboxEffectName,
  wrapSandboxAcquire,
  wrapSandboxExec,
  wrapSandboxWrite,
  wrapSandboxEdit,
  wrapSandboxSync,
  wrapSandboxClose,
  buildHandleStateHasher,
  type DurableSandboxOptions,
} from './durable-wrap.js';
