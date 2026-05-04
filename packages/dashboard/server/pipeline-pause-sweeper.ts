/**
 * PipelinePauseSweeper — periodically transitions paused runs whose
 * `timeoutAt` has elapsed to the `timed-out` status, then invokes a caller
 * supplied `onTimeout` callback (e.g. to broadcast over WS or record metrics).
 *
 * NOTE: the sweeper runs **in-process**. The owner (dashboard server) is
 * responsible for instantiating it once at boot and calling `start()`. A
 * forked worker or separate process would each run their own sweeper —
 * keep exactly one owner per Anvil home to avoid duplicate side effects.
 */

import type { PipelinePauseStore } from './pipeline-pause-store.js';
import type { PauseState } from './pipeline-pause-types.js';

export interface PipelinePauseSweeperOptions {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Called once per pause that transitions from awaiting → timed-out. */
  onTimeout: (state: PauseState) => void;
  /**
   * Optional error hook invoked when a tick throws (e.g. transient IO error).
   * Defaults to logging to `console.error`.
   */
  onError?: (err: unknown) => void;
}

class PipelinePauseSweeper {
  private store: PipelinePauseStore;
  private opts: PipelinePauseSweeperOptions;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(store: PipelinePauseStore, opts: PipelinePauseSweeperOptions) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
      throw new Error('PipelinePauseSweeper: intervalMs must be a positive number');
    }
    this.store = store;
    this.opts = opts;
  }

  /** Start polling. Safe to call repeatedly — no-op if already running. */
  start(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => this.tick(), this.opts.intervalMs);
    // Do not block process exit on this timer.
    if (typeof this.handle === 'object' && this.handle !== null && 'unref' in this.handle) {
      try {
        (this.handle as { unref: () => void }).unref();
      } catch {
        // best-effort — unref is not available on all timer implementations.
      }
    }
  }

  /** Stop polling. Safe to call repeatedly. */
  stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }

  /** Run a single sweep. Exposed for testing — prefer start()/stop() in prod. */
  tick(): void {
    try {
      const now = Date.now();
      const awaiting = this.store.list({ status: 'paused-awaiting-user' });
      for (const state of awaiting) {
        if (!state.timeoutAt) continue;
        const deadline = Date.parse(state.timeoutAt);
        if (!Number.isFinite(deadline)) continue;
        if (deadline >= now) continue;
        let updated: PauseState;
        try {
          updated = this.store.markTimedOut(state.runId);
        } catch (err) {
          this.reportError(err);
          continue;
        }
        // Only notify if the transition actually happened.
        if (updated.status === 'timed-out') {
          try {
            this.opts.onTimeout(updated);
          } catch (err) {
            this.reportError(err);
          }
        }
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    if (this.opts.onError) {
      try {
        this.opts.onError(err);
      } catch {
        // swallow — an error in the error hook must not crash the sweeper.
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[pipeline-pause-sweeper]', err);
  }
}

export { PipelinePauseSweeper };
