/**
 * Sandbox runner boot registration — Phase S follow-up #1.
 *
 * Runs once during dashboard startup. Each runtime is probed for
 * availability before registration so `getSandboxRunner('docker')`
 * doesn't return a runner that immediately fails on `isAvailable()`.
 *
 * Order matters: we always register `none` first (already pre-
 * registered by core-pipeline). Then docker if available, then
 * firecracker / gvisor. Probes are best-effort — when docker isn't
 * on PATH, we silently skip registration and the dashboard's
 * `getSandboxRunner('docker')` callsite gets the canonical
 * "not registered" error.
 *
 * `ANVIL_SANDBOX_FORCE_NONE=1` skips every registration so users
 * without container runtimes installed don't see runtime errors
 * (Phase S follow-up #4).
 */
import { registerSandboxRunner } from '@esankhan3/anvil-core-pipeline';
import { DockerSandboxRunner } from './docker-runner.js';
import { FirecrackerSandboxRunner } from './firecracker-runner.js';
import { GVisorSandboxRunner } from './gvisor-runner.js';
import { PooledSandboxRunner } from './pooled-runner.js';
export async function registerSandboxRunnersAtBoot() {
    if (process.env.ANVIL_SANDBOX_FORCE_NONE === '1') {
        return { registered: [], skippedReason: 'ANVIL_SANDBOX_FORCE_NONE=1' };
    }
    const out = { registered: [] };
    // Docker — the canonical Mode 1 runtime. Pool-wrapped so multiple
    // stages within a run share warm containers (S7 design).
    try {
        const probe = new DockerSandboxRunner();
        if (await probe.isAvailable()) {
            registerSandboxRunner('docker', () => new PooledSandboxRunner(new DockerSandboxRunner()));
            out.registered.push('docker');
        }
    }
    catch { /* probe failed — silently skip */ }
    // Firecracker — opt-in microVM, Linux + KVM only.
    try {
        const probe = new FirecrackerSandboxRunner();
        if (await probe.isAvailable()) {
            registerSandboxRunner('firecracker', () => new PooledSandboxRunner(new FirecrackerSandboxRunner()));
            out.registered.push('firecracker');
        }
    }
    catch { /* skip */ }
    // gVisor — opt-in user-space kernel, Linux + runsc only.
    try {
        const probe = new GVisorSandboxRunner();
        if (await probe.isAvailable()) {
            registerSandboxRunner('gvisor', () => new PooledSandboxRunner(new GVisorSandboxRunner()));
            out.registered.push('gvisor');
        }
    }
    catch { /* skip */ }
    return out;
}
//# sourceMappingURL=register-at-boot.js.map