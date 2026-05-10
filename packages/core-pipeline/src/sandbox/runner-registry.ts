/**
 * `SandboxRunner` factory + process-wide registry.
 *
 * Concrete runners (`docker`, `firecracker`, `gvisor`) live in the
 * dashboard because they require runtime-specific binaries. They
 * register themselves at boot via `registerSandboxRunner(runtime, fn)`.
 *
 * The dashboard wires:
 *
 *   registerSandboxRunner('docker', () => new DockerSandboxRunner(...));
 *   registerSandboxRunner('firecracker', () => new FirecrackerSandboxRunner(...));
 *
 * Stages then call `getSandboxRunner('docker')` and don't care about
 * the wiring.
 */

import { NoneSandboxRunner } from './none-runner.js';
import type { SandboxRunner, SandboxRuntime } from './types.js';

type RunnerFactory = () => SandboxRunner;

const runnerFactories: Map<SandboxRuntime, RunnerFactory> = new Map();
const runnerInstances: Map<SandboxRuntime, SandboxRunner> = new Map();

// Register the `none` runner unconditionally — it has no external deps.
runnerFactories.set('none', () => new NoneSandboxRunner());

/**
 * Register a factory for a runtime. Idempotent — calling twice replaces
 * the prior factory and disposes any cached instance.
 */
export function registerSandboxRunner(runtime: SandboxRuntime, factory: RunnerFactory): void {
  runnerFactories.set(runtime, factory);
  // Drop any cached instance so the next acquire builds via the new factory.
  const cached = runnerInstances.get(runtime);
  if (cached) {
    void cached.shutdown().catch(() => { /* shutdown best-effort */ });
    runnerInstances.delete(runtime);
  }
}

/**
 * True iff a factory is registered for this runtime. The dashboard's
 * boot sequence uses this to decide whether Docker / Firecracker are
 * actually installed before it picks a default.
 */
export function isSandboxRunnerRegistered(runtime: SandboxRuntime): boolean {
  return runnerFactories.has(runtime);
}

/**
 * Acquire (or lazily build) the singleton runner for a runtime. Throws
 * when the runtime hasn't been registered.
 */
export function getSandboxRunner(runtime: SandboxRuntime): SandboxRunner {
  let instance = runnerInstances.get(runtime);
  if (instance) return instance;
  const factory = runnerFactories.get(runtime);
  if (!factory) {
    throw new Error(`sandbox runtime "${runtime}" is not registered. Did you forget to call registerSandboxRunner('${runtime}', ...) at boot?`);
  }
  instance = factory();
  runnerInstances.set(runtime, instance);
  return instance;
}

/**
 * Shutdown every active runner. The dashboard calls this during clean
 * shutdown so containers/VMs aren't left orphaned.
 */
export async function shutdownAllSandboxRunners(): Promise<void> {
  const runners = Array.from(runnerInstances.values());
  runnerInstances.clear();
  for (const r of runners) {
    await r.shutdown().catch(() => { /* best-effort */ });
  }
}

/** Test-only: clear the registry so individual tests don't leak state. */
export function __resetSandboxRegistryForTests(): void {
  runnerInstances.clear();
  runnerFactories.clear();
  runnerFactories.set('none', () => new NoneSandboxRunner());
}
