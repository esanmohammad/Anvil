/**
 * RunTimeline — record stage start/end/duration/status.
 */

export interface TimelineEntry {
  stageName: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  error?: string;
}

export interface TimelineSummary {
  entries: readonly TimelineEntry[];
  totalDurationMs: number;
  completedStages: number;
  failedStages: number;
  skippedStages: number;
}

export class RunTimeline {
  private entries: Map<string, TimelineEntry> = new Map();
  private order: string[] = [];

  /** Record the start of a stage. */
  recordStart(stageName: string): void {
    const entry: TimelineEntry = {
      stageName,
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    this.entries.set(stageName, entry);
    if (!this.order.includes(stageName)) {
      this.order.push(stageName);
    }
  }

  /** Record the completion of a stage. */
  recordEnd(stageName: string, status: 'completed' | 'failed' | 'skipped' = 'completed', error?: string): void {
    const entry = this.entries.get(stageName);
    if (!entry) return;
    entry.endedAt = new Date().toISOString();
    entry.durationMs = new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime();
    entry.status = status;
    if (error) entry.error = error;
  }

  /** Get a specific stage entry. */
  getEntry(stageName: string): TimelineEntry | undefined {
    return this.entries.get(stageName);
  }

  /** Get all entries in order. */
  getEntries(): readonly TimelineEntry[] {
    return this.order.map((name) => this.entries.get(name)!).filter(Boolean);
  }

  /** Get summary of all stages. */
  getSummary(): TimelineSummary {
    const entries = this.getEntries();
    const totalDurationMs = entries.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    return {
      entries,
      totalDurationMs,
      completedStages: entries.filter((e) => e.status === 'completed').length,
      failedStages: entries.filter((e) => e.status === 'failed').length,
      skippedStages: entries.filter((e) => e.status === 'skipped').length,
    };
  }

  /** Get total duration across all completed stages. */
  getTotalDuration(): number {
    return this.getEntries().reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  }
}
