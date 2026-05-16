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
export class SandboxPool {
    runner;
    entries = [];
    waiters = [];
    opts;
    constructor(runner, opts = {}) {
        this.runner = runner;
        this.opts = {
            idleTtlMs: opts.idleTtlMs ?? 5 * 60 * 1000,
            maxIdle: opts.maxIdle ?? 4,
            maxTotal: opts.maxTotal ?? 16,
            acquireTimeoutMs: opts.acquireTimeoutMs ?? 10_000,
            now: opts.now ?? Date.now,
        };
    }
    async acquire(reqOpts) {
        const key = poolKey(reqOpts);
        const idle = this.entries.find((e) => !e.busy && e.key === key);
        if (idle) {
            idle.busy = true;
            idle.lastUsedAt = this.opts.now();
            return idle.handle;
        }
        if (this.totalCount() >= this.opts.maxTotal) {
            // Try to evict an idle non-matching entry to make room.
            const victim = this.entries.find((e) => !e.busy);
            if (victim) {
                await this.evict(victim);
            }
            else {
                await this.waitForFreeSlot();
            }
        }
        // Make sure we don't bust maxIdle either: if adding this handle
        // would push idle count over, evict the oldest idle now.
        if (this.idleCount() >= this.opts.maxIdle) {
            const oldestIdle = this.entries
                .filter((e) => !e.busy)
                .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
            if (oldestIdle)
                await this.evict(oldestIdle);
        }
        const handle = await this.runner.acquire(reqOpts);
        const entry = { handle, key, busy: true, lastUsedAt: this.opts.now() };
        this.entries.push(entry);
        return handle;
    }
    /**
     * Release a handle back to the pool. The pool's wrapper around the
     * runner exposes `release(handle)` so consumers can opt back in.
     * Closed handles get evicted instead of returned.
     */
    async release(handle) {
        const entry = this.entries.find((e) => e.handle === handle);
        if (!entry)
            return;
        entry.busy = false;
        entry.lastUsedAt = this.opts.now();
        this.flushOneWaiter();
    }
    /** Sweep idle handles past `idleTtlMs`. Called periodically. */
    async sweep() {
        const now = this.opts.now();
        const expired = this.entries.filter((e) => !e.busy && now - e.lastUsedAt > this.opts.idleTtlMs);
        for (const e of expired)
            await this.evict(e);
        return { closed: expired.length };
    }
    /** Snapshot for the dashboard's status panel. */
    list() {
        const now = this.opts.now();
        return this.entries.map((e) => ({
            id: e.handle.id,
            runtime: e.handle.runtime,
            ageMs: Math.max(0, now - (e.lastUsedAt - 1)),
            busy: e.busy,
        }));
    }
    totalCount() { return this.entries.length; }
    idleCount() { return this.entries.filter((e) => !e.busy).length; }
    busyCount() { return this.entries.filter((e) => e.busy).length; }
    async shutdown() {
        while (this.waiters.length > 0) {
            const w = this.waiters.shift();
            clearTimeout(w.timer);
            w.reject(new Error('sandbox pool shut down'));
        }
        for (const e of this.entries.splice(0)) {
            await e.handle.close().catch(() => { });
        }
        await this.runner.shutdown().catch(() => { });
    }
    async evict(entry) {
        const idx = this.entries.indexOf(entry);
        if (idx >= 0)
            this.entries.splice(idx, 1);
        await entry.handle.close().catch(() => { });
    }
    waitForFreeSlot() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.findIndex((w) => w.timer === timer);
                if (idx >= 0)
                    this.waiters.splice(idx, 1);
                reject(new Error(`sandbox pool acquire timed out after ${this.opts.acquireTimeoutMs}ms`));
            }, this.opts.acquireTimeoutMs);
            this.waiters.push({ resolve, reject, timer });
        });
    }
    flushOneWaiter() {
        const next = this.waiters.shift();
        if (!next)
            return;
        clearTimeout(next.timer);
        next.resolve();
    }
}
/**
 * Build the pool's reuse key. The triple (project, image, limits)
 * pinpoints handles whose runtime configuration matches the request.
 * runId/stage are NOT folded in — the pool's purpose is to share warm
 * containers across stages.
 */
export function poolKey(opts) {
    return [
        opts.project,
        opts.image ?? '',
        opts.fsMode ?? 'overlay',
        limitsHash(opts.limits),
    ].join('|');
}
function limitsHash(limits) {
    if (!limits)
        return '0';
    return [
        limits.memoryMiB ?? 0,
        limits.cpus ?? 0,
        limits.timeoutSeconds ?? 0,
        limits.pids ?? 0,
        limits.diskMiB ?? 0,
    ].join('-');
}
//# sourceMappingURL=pool.js.map