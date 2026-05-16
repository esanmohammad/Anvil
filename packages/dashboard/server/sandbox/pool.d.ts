/**
 * Sandbox warm pool — Phase S7.
 *
 * Wraps any `SandboxRunner` with a per-(project, image, limits)
 * cache: when a stage acquires a sandbox, the pool reuses an idle
 * handle that matches the request key instead of spinning a new
 * container.
 *
 * Eviction model:
 *   - Per-handle idle TTL: when a handle has been idle longer than
 *     `idleTtlMs`, the next `sweep()` closes it.
 *   - Hard cap on total handles (`maxTotal`): when adding a new
 *     handle would exceed the cap, the oldest IDLE handle is evicted
 *     first; if all are busy, `acquire()` waits up to
 *     `acquireTimeoutMs` then throws.
 *   - `maxIdle` keeps memory bounded — the pool never holds more
 *     idle handles than this even if the project's sandbox is small.
 *
 * Used by `DockerSandboxRunner` once S7 ships; until then the runner
 * vends new handles per-acquire (zero-cost regression).
 */
import type { AcquireSandboxOpts, SandboxHandle, SandboxRunner, SandboxRunnerListEntry } from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
/** Tunables for the pool. Defaults match §J of the plan. */
export interface PoolOptions {
    /** Per-handle idle TTL. Default 5 min. */
    idleTtlMs?: number;
    /** Per-pool hard cap on idle (warm) handles. Default 4. */
    maxIdle?: number;
    /** Per-pool hard cap on total (idle + busy) handles. Default 16. */
    maxTotal?: number;
    /** When the pool is at maxTotal and every handle is busy, how long
     *  to wait before throwing. Default 10 s. */
    acquireTimeoutMs?: number;
    /** Wall clock (ms-resolution). Test seam — defaults to Date.now. */
    now?: () => number;
}
export declare class SandboxPool {
    private readonly runner;
    private readonly entries;
    private readonly waiters;
    private readonly opts;
    constructor(runner: SandboxRunner, opts?: PoolOptions);
    acquire(reqOpts: AcquireSandboxOpts): Promise<SandboxHandle>;
    /**
     * Release a handle back to the pool. The pool's wrapper around the
     * runner exposes `release(handle)` so consumers can opt back in.
     * Closed handles get evicted instead of returned.
     */
    release(handle: SandboxHandle): Promise<void>;
    /** Sweep idle handles past `idleTtlMs`. Called periodically. */
    sweep(): Promise<{
        closed: number;
    }>;
    /** Snapshot for the dashboard's status panel. */
    list(): readonly SandboxRunnerListEntry[];
    totalCount(): number;
    idleCount(): number;
    busyCount(): number;
    shutdown(): Promise<void>;
    private evict;
    private waitForFreeSlot;
    private flushOneWaiter;
}
/**
 * Build the pool's reuse key. The triple (project, image, limits)
 * pinpoints handles whose runtime configuration matches the request.
 * runId/stage are NOT folded in — the pool's purpose is to share warm
 * containers across stages.
 */
export declare function poolKey(opts: AcquireSandboxOpts): string;
//# sourceMappingURL=pool.d.ts.map