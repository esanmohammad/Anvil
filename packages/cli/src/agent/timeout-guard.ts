/**
 * Agent Process Manager — timeout handling with grace-period support.
 */

import { getDefaultTimeout } from './types.js';

export class TimeoutGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private gracePeriodMs: number;

  constructor(gracePeriodMs = 5_000) {
    this.gracePeriodMs = gracePeriodMs;
  }

  /**
   * Start the timeout.  When `timeoutMs` elapses, `onTimeout` is invoked.
   * If a `kill` callback is provided the guard will send SIGTERM first, then
   * SIGKILL after the grace period.
   */
  start(
    timeoutMs: number,
    onTimeout: () => void,
    kill?: (signal: NodeJS.Signals) => void,
  ): void {
    this.cancel();
    this.active = true;

    this.timer = setTimeout(() => {
      this.active = false;
      if (kill) {
        kill('SIGTERM');
        this.graceTimer = setTimeout(() => {
          kill('SIGKILL');
        }, this.gracePeriodMs);
      }
      onTimeout();
    }, timeoutMs);
  }

  /** Cancel any pending timeout. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.active = false;
  }

  /** Whether the timeout is currently ticking. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Factory: create a TimeoutGuard pre-configured for a pipeline stage.
   */
  static createForStage(stage: string): TimeoutGuard {
    // The actual timeout value is applied at .start() time; this just creates
    // the guard instance. Callers use getDefaultTimeout(stage) for the value.
    void getDefaultTimeout(stage); // validate stage exists
    return new TimeoutGuard();
  }
}
