/**
 * pipeline-escalation — periodic sweeper that promotes long-unresolved
 * paused runs to a fallback reviewer list. Integration wires `onEscalate` to
 * re-send notifications with a different reviewer group.
 */

type PauseStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';
type PauseStatus = 'paused-awaiting-user' | 'resumed' | 'cancelled' | 'timed-out';

export interface PauseState {
  runId: string;
  project: string;
  stage: PauseStage;
  reason: string;
  matchedRules: string[];
  reviewers: string[];
  pausedAt: string;
  timeoutAt?: string;
  status: PauseStatus;
}

export type EscalationTier = 'primary' | 'fallback';

export interface PipelineEscalationOptions {
  /** How often to scan pauses. */
  intervalMs: number;
  /** Threshold (hours since `pausedAt`) at which the sweeper fires. */
  escalationAfterHours: number;
  /** Callback invoked once per escalated runId. May be async. */
  onEscalate: (runId: string, tier: EscalationTier) => void | Promise<void>;
  /** Returns the current set of pauses to scan. */
  listPauses: () => PauseState[];
  /** Optional clock override for testability. */
  now?: () => number;
}

export class PipelineEscalation {
  private readonly opts: PipelineEscalationOptions;
  private readonly escalated = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: PipelineEscalationOptions) {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
      throw new Error('PipelineEscalation: intervalMs must be a positive finite number');
    }
    if (!Number.isFinite(opts.escalationAfterHours) || opts.escalationAfterHours < 0) {
      throw new Error('PipelineEscalation: escalationAfterHours must be >= 0');
    }
    this.opts = opts;
  }

  start(): void {
    if (this.timer !== null) return;
    // `unref` so the sweeper never blocks process exit.
    const timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Force a single sweep — useful for tests and on-demand reconciliation. */
  async tick(): Promise<void> {
    if (this.running) return; // Prevent overlapping sweeps if a tick runs long.
    this.running = true;
    try {
      const nowMs = (this.opts.now ?? Date.now)();
      const thresholdMs = this.opts.escalationAfterHours * 3600 * 1000;

      let pauses: PauseState[];
      try {
        pauses = this.opts.listPauses();
      } catch {
        return; // Swallow — bad listPauses shouldn't kill the interval.
      }

      for (const p of pauses) {
        if (p.status !== 'paused-awaiting-user') continue;
        if (this.escalated.has(p.runId)) continue;
        const pausedMs = Date.parse(p.pausedAt);
        if (Number.isNaN(pausedMs)) continue;
        if (nowMs - pausedMs < thresholdMs) continue;

        this.escalated.add(p.runId);
        try {
          await this.opts.onEscalate(p.runId, 'fallback');
        } catch {
          // Swallow — next tick will retry IFF we remove from the set.
          // Leaving it in the set keeps "at-most-once-per-run-lifetime"
          // semantics; the integration layer can clear via `reset` if a
          // manual re-escalation is wanted.
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Clear escalation memory for a runId — useful if the pause is re-opened. */
  reset(runId: string): void {
    this.escalated.delete(runId);
  }

  /** For tests / diagnostics. */
  hasEscalated(runId: string): boolean {
    return this.escalated.has(runId);
  }
}
