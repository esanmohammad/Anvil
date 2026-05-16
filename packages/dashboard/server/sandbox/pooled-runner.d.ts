/**
 * Adapter that wraps a `SandboxRunner` with a `SandboxPool`,
 * exposing the same `SandboxRunner` interface so consumers don't
 * have to know whether the runner is pooled.
 *
 * Phase S follow-up #3 — `SandboxPool` was built in S7 but never
 * wrapped around the actual runners. This file is the seam.
 */
import type { AcquireSandboxOpts, SandboxHandle, SandboxRunner, SandboxRunnerListEntry } from '@esankhan3/anvil-core-pipeline';
import { type PoolOptions } from './pool.js';
export declare class PooledSandboxRunner implements SandboxRunner {
    private readonly pool;
    constructor(inner: SandboxRunner, opts?: PoolOptions);
    acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle>;
    /** Pool-wrapped handles need a `release` path; otherwise the pool
     *  never sees idle slots. The runner consumer should call
     *  `release(handle)` when it's done with a handle for THIS run. */
    release(handle: SandboxHandle): Promise<void>;
    list(): Promise<readonly SandboxRunnerListEntry[]>;
    sweep(): Promise<{
        closed: number;
    }>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=pooled-runner.d.ts.map