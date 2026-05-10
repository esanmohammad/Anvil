/**
 * Lease manager — Phase D6 multi-process scheduler primitive.
 *
 * Holds a periodic heartbeat against `DurableStore.renewLease` so a
 * crashed peer's lease expires within `ttlMs`. Companion processes
 * detect expired leases and race to take over via
 * `acquireLease`. The first `INSERT/UPDATE WHERE lease_holder=? AND
 * lease_expires<?` wins; the loser backs off + retries.
 *
 * One LeaseManager per (runId, holder) pair. The dashboard's
 * PipelineRunner constructs one in `run()` and `stop()`s it before
 * the run terminates. The cli's resume command does the same.
 *
 * The manager is a simple state machine:
 *   - acquired   — interval ticking; lease alive
 *   - expired    — heartbeat detected we lost ownership; emits 'lost'
 *   - stopped    — caller called `.stop()` (clean shutdown)
 */

import { EventEmitter } from 'node:events';

import type { DurableStore } from './store.js';

export interface LeaseManagerOptions {
  store: DurableStore;
  runId: string;
  holder: string;
  /** Lease lifetime per heartbeat. Default 60s. */
  ttlMs?: number;
  /** Heartbeat interval. Default ttlMs / 3. */
  intervalMs?: number;
  /** Test seam — replace `setInterval`. */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

export interface LeaseManagerEvents {
  /** Emitted when a heartbeat fails to renew (peer stole the lease). */
  lost: () => void;
  /** Emitted on each successful heartbeat. */
  beat: () => void;
  /** Emitted when an unhandled error occurs inside a heartbeat. */
  error: (err: Error) => void;
}

export class LeaseManager extends EventEmitter {
  private readonly store: DurableStore;
  private readonly runId: string;
  private readonly holder: string;
  private readonly ttlMs: number;
  private readonly intervalMs: number;
  private readonly scheduler: NonNullable<LeaseManagerOptions['scheduler']>;
  private handle: unknown = null;
  private state: 'idle' | 'running' | 'stopped' | 'lost' = 'idle';

  constructor(opts: LeaseManagerOptions) {
    super();
    this.store = opts.store;
    this.runId = opts.runId;
    this.holder = opts.holder;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.intervalMs = opts.intervalMs ?? Math.max(2000, Math.floor(this.ttlMs / 3));
    this.scheduler = opts.scheduler ?? {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  /** Begin heartbeat. Caller must have already acquired the lease. */
  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'running';
    this.handle = this.scheduler.setInterval(() => {
      void this.heartbeat();
    }, this.intervalMs);
    if (typeof (this.handle as { unref?: () => void }).unref === 'function') {
      (this.handle as { unref: () => void }).unref();
    }
  }

  /** Stop heartbeat. Releases the lease best-effort. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.handle !== null) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
    try {
      await this.store.releaseLease(this.runId, this.holder);
    } catch {
      /* swallow — best effort */
    }
  }

  isAlive(): boolean {
    return this.state === 'running';
  }

  private async heartbeat(): Promise<void> {
    if (this.state !== 'running') return;
    try {
      const renewed = await this.store.renewLease(this.runId, this.holder, this.ttlMs);
      if (!renewed) {
        this.state = 'lost';
        if (this.handle !== null) {
          this.scheduler.clearInterval(this.handle);
          this.handle = null;
        }
        this.emit('lost');
        return;
      }
      this.emit('beat');
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Race-for-lease helper. Used by the dashboard / cli on startup
 * when scanning for in-flight runs that have no live owner.
 *
 * Returns true if this caller acquired the lease, false if a live
 * peer already owns it.
 *
 * Conservative semantics: even when `runs.lease_expires` shows
 * expired, we re-read the row in a transaction (delegated to the
 * driver's `acquireLease`) so we never run two peers against the
 * same row.
 */
export async function tryTakeOverLease(
  store: DurableStore,
  runId: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  return store.acquireLease(runId, holder, ttlMs);
}

/**
 * Returns the list of `running` runs whose lease has expired (no live
 * peer). Suitable inputs for an automated takeover loop.
 */
export async function findOrphanedRuns(
  store: DurableStore,
  now: () => number = Date.now,
): Promise<string[]> {
  const running = await store.listRunsByStatus('running');
  const cutoff = now();
  return running
    .filter((r) => {
      if (!r.leaseExpires) return true;
      return Date.parse(r.leaseExpires) < cutoff;
    })
    .map((r) => r.runId);
}
