/**
 * StageTimeoutManager — per-stage timeout configuration and enforcement.
 */

export interface StageTimeoutConfig {
  [stageName: string]: number; // ms
}

export interface TimeoutResult {
  timedOut: boolean;
  stageName: string;
  elapsedMs: number;
  partialOutput?: string;
}

const DEFAULT_TIMEOUTS: StageTimeoutConfig = {
  clarify: 5 * 60_000,
  requirements: 10 * 60_000,
  'project-requirements': 10 * 60_000,
  specs: 15 * 60_000,
  tasks: 15 * 60_000,
  build: 15 * 60_000,
  validate: 10 * 60_000,
  ship: 10 * 60_000,
};

export class StageTimeoutManager {
  private timeouts: StageTimeoutConfig;
  private activeTimers: Map<string, { timer: ReturnType<typeof setTimeout>; startedAt: number }> =
    new Map();
  private results: Map<string, TimeoutResult> = new Map();

  constructor(overrides?: Record<string, number>) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...overrides };
  }

  /** Get the configured timeout for a stage in ms. */
  getTimeout(stageName: string): number {
    return this.timeouts[stageName] ?? DEFAULT_TIMEOUTS.build;
  }

  /** Start a timeout for a stage. Returns a promise that rejects on timeout. */
  startTimeout(
    stageName: string,
    onTimeout: (result: TimeoutResult) => void,
  ): void {
    this.clearTimeout(stageName);
    const timeoutMs = this.getTimeout(stageName);
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      const result: TimeoutResult = {
        timedOut: true,
        stageName,
        elapsedMs: Date.now() - startedAt,
      };
      this.results.set(stageName, result);
      this.activeTimers.delete(stageName);
      onTimeout(result);
    }, timeoutMs);

    this.activeTimers.set(stageName, { timer, startedAt });
  }

  /** Clear a specific stage timeout. */
  clearTimeout(stageName: string): void {
    const entry = this.activeTimers.get(stageName);
    if (entry) {
      globalThis.clearTimeout(entry.timer);
      this.activeTimers.delete(stageName);
    }
  }

  /** Mark a stage as completed (no timeout). */
  markCompleted(stageName: string): TimeoutResult {
    const entry = this.activeTimers.get(stageName);
    const elapsedMs = entry ? Date.now() - entry.startedAt : 0;
    this.clearTimeout(stageName);
    const result: TimeoutResult = { timedOut: false, stageName, elapsedMs };
    this.results.set(stageName, result);
    return result;
  }

  /** Clear all active timers. */
  clearAll(): void {
    for (const [name] of this.activeTimers) {
      this.clearTimeout(name);
    }
  }

  /** Get results of completed/timed-out stages. */
  getResults(): Map<string, TimeoutResult> {
    return new Map(this.results);
  }

  /** Check if a timer is active for the given stage. */
  isActive(stageName: string): boolean {
    return this.activeTimers.has(stageName);
  }
}
