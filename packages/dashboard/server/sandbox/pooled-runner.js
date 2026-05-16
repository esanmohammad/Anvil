/**
 * Adapter that wraps a `SandboxRunner` with a `SandboxPool`,
 * exposing the same `SandboxRunner` interface so consumers don't
 * have to know whether the runner is pooled.
 *
 * Phase S follow-up #3 — `SandboxPool` was built in S7 but never
 * wrapped around the actual runners. This file is the seam.
 */
import { SandboxPool } from './pool.js';
export class PooledSandboxRunner {
    pool;
    constructor(inner, opts = {}) {
        this.pool = new SandboxPool(inner, opts);
    }
    async acquire(opts) {
        return this.pool.acquire(opts);
    }
    /** Pool-wrapped handles need a `release` path; otherwise the pool
     *  never sees idle slots. The runner consumer should call
     *  `release(handle)` when it's done with a handle for THIS run. */
    async release(handle) {
        return this.pool.release(handle);
    }
    async list() {
        return this.pool.list();
    }
    async sweep() {
        return this.pool.sweep();
    }
    async shutdown() {
        return this.pool.shutdown();
    }
}
//# sourceMappingURL=pooled-runner.js.map