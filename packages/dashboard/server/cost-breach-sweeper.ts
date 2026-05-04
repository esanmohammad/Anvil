/**
 * CostBreachSweeper — polls pending breaches and auto-resolves any whose
 * grace window has elapsed. Mirrors PipelinePauseSweeper in shape so that
 * the dashboard server can instantiate it once at boot and forget about it.
 *
 * Only one sweeper should run per Anvil home — otherwise the same breach
 * may be resolved twice (the handler is idempotent on terminal states but
 * `onRejectStop` could still fire twice).
 */

import type { CostBreachHandler, CostPolicy } from './cost-breach-handler.js';

export interface CostBreachSweeperOptions {
  intervalMs: number;
  /**
   * Optional policy to pass to `resolveExpired`. If absent, the handler
   * applies its built-in default (reject).
   */
  policyFor?: (runId: string) => CostPolicy | undefined;
  onError?: (err: unknown) => void;
}

class CostBreachSweeper {
  private handler: CostBreachHandler;
  private opts: CostBreachSweeperOptions;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(handler: CostBreachHandler, opts: CostBreachSweeperOptions) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
      throw new Error('CostBreachSweeper: intervalMs must be a positive number');
    }
    this.handler = handler;
    this.opts = opts;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    if (typeof this.handle === 'object' && this.handle !== null && 'unref' in this.handle) {
      try {
        (this.handle as { unref: () => void }).unref();
      } catch {
        // best effort
      }
    }
  }

  stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }

  /** Single sweep. Exposed for tests. */
  async tick(): Promise<void> {
    try {
      const pending = this.handler.listPending();
      const now = Date.now();
      for (const state of pending) {
        const deadline = Date.parse(state.graceEndsAt);
        if (!Number.isFinite(deadline)) continue;
        if (deadline >= now) continue;
        const policy = this.opts.policyFor?.(state.runId);
        try {
          await this.handler.resolveExpired(state.runId, policy);
        } catch (err) {
          this.reportError(err);
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
        // swallow
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[cost-breach-sweeper]', err);
  }
}

export { CostBreachSweeper };
