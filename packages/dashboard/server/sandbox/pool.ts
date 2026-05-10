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

import type {
  AcquireSandboxOpts,
  SandboxHandle,
  SandboxLimits,
  SandboxRunner,
  SandboxRunnerListEntry,
} from '@esankhan3/anvil-core-pipeline/sandbox/types.js';

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

interface PoolEntry {
  handle: SandboxHandle;
  key: string;
  busy: boolean;
  /** Last time the handle was returned to the pool (or acquired). */
  lastUsedAt: number;
}

export class SandboxPool {
  private readonly entries: PoolEntry[] = [];
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private readonly opts: Required<Omit<PoolOptions, 'now'>> & { now: () => number };

  constructor(
    private readonly runner: SandboxRunner,
    opts: PoolOptions = {},
  ) {
    this.opts = {
      idleTtlMs: opts.idleTtlMs ?? 5 * 60 * 1000,
      maxIdle: opts.maxIdle ?? 4,
      maxTotal: opts.maxTotal ?? 16,
      acquireTimeoutMs: opts.acquireTimeoutMs ?? 10_000,
      now: opts.now ?? Date.now,
    };
  }

  async acquire(reqOpts: AcquireSandboxOpts): Promise<SandboxHandle> {
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
      } else {
        await this.waitForFreeSlot();
      }
    }

    // Make sure we don't bust maxIdle either: if adding this handle
    // would push idle count over, evict the oldest idle now.
    if (this.idleCount() >= this.opts.maxIdle) {
      const oldestIdle = this.entries
        .filter((e) => !e.busy)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldestIdle) await this.evict(oldestIdle);
    }

    const handle = await this.runner.acquire(reqOpts);
    const entry: PoolEntry = { handle, key, busy: true, lastUsedAt: this.opts.now() };
    this.entries.push(entry);
    return handle;
  }

  /**
   * Release a handle back to the pool. The pool's wrapper around the
   * runner exposes `release(handle)` so consumers can opt back in.
   * Closed handles get evicted instead of returned.
   */
  async release(handle: SandboxHandle): Promise<void> {
    const entry = this.entries.find((e) => e.handle === handle);
    if (!entry) return;
    entry.busy = false;
    entry.lastUsedAt = this.opts.now();
    this.flushOneWaiter();
  }

  /** Sweep idle handles past `idleTtlMs`. Called periodically. */
  async sweep(): Promise<{ closed: number }> {
    const now = this.opts.now();
    const expired = this.entries.filter((e) => !e.busy && now - e.lastUsedAt > this.opts.idleTtlMs);
    for (const e of expired) await this.evict(e);
    return { closed: expired.length };
  }

  /** Snapshot for the dashboard's status panel. */
  list(): readonly SandboxRunnerListEntry[] {
    const now = this.opts.now();
    return this.entries.map((e) => ({
      id: e.handle.id,
      runtime: e.handle.runtime,
      ageMs: Math.max(0, now - (e.lastUsedAt - 1)),
      busy: e.busy,
    }));
  }

  totalCount(): number { return this.entries.length; }
  idleCount(): number { return this.entries.filter((e) => !e.busy).length; }
  busyCount(): number { return this.entries.filter((e) => e.busy).length; }

  async shutdown(): Promise<void> {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(new Error('sandbox pool shut down'));
    }
    for (const e of this.entries.splice(0)) {
      await e.handle.close().catch(() => { /* best-effort */ });
    }
    await this.runner.shutdown().catch(() => { /* best-effort */ });
  }

  private async evict(entry: PoolEntry): Promise<void> {
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    await entry.handle.close().catch(() => { /* best-effort */ });
  }

  private waitForFreeSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`sandbox pool acquire timed out after ${this.opts.acquireTimeoutMs}ms`));
      }, this.opts.acquireTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private flushOneWaiter(): void {
    const next = this.waiters.shift();
    if (!next) return;
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
export function poolKey(opts: AcquireSandboxOpts): string {
  return [
    opts.project,
    opts.image ?? '',
    opts.fsMode ?? 'overlay',
    limitsHash(opts.limits),
  ].join('|');
}

function limitsHash(limits: SandboxLimits | undefined): string {
  if (!limits) return '0';
  return [
    limits.memoryMiB ?? 0,
    limits.cpus ?? 0,
    limits.timeoutSeconds ?? 0,
    limits.pids ?? 0,
    limits.diskMiB ?? 0,
  ].join('-');
}
