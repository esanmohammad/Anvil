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
export interface BootRegistrationResult {
    registered: Array<'docker' | 'firecracker' | 'gvisor'>;
    skippedReason?: string;
}
export declare function registerSandboxRunnersAtBoot(): Promise<BootRegistrationResult>;
//# sourceMappingURL=register-at-boot.d.ts.map