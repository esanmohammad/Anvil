/**
 * LatencyTracker — wrap tool calls, record duration/success/size, compute percentiles.
 */

export interface LatencyRecord {
  tool: string;
  durationMs: number;
  success: boolean;
  payloadSize?: number;
  timestamp: string;
}

export interface LatencyStats {
  tool: string;
  count: number;
  successCount: number;
  failureCount: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export class LatencyTracker {
  private records: LatencyRecord[] = [];

  /** Wrap a tool call and record its latency. */
  async track<T>(
    tool: string,
    fn: () => Promise<T>,
    payloadSize?: number,
  ): Promise<T> {
    const start = Date.now();
    let success = true;
    try {
      return await fn();
    } catch (err) {
      success = false;
      throw err;
    } finally {
      this.records.push({
        tool,
        durationMs: Date.now() - start,
        success,
        payloadSize,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /** Record a completed call manually. */
  record(tool: string, durationMs: number, success: boolean, payloadSize?: number): void {
    this.records.push({
      tool,
      durationMs,
      success,
      payloadSize,
      timestamp: new Date().toISOString(),
    });
  }

  /** Get latency statistics for a specific tool. */
  getStats(tool: string): LatencyStats | null {
    const toolRecords = this.records.filter((r) => r.tool === tool);
    if (toolRecords.length === 0) return null;

    const durations = toolRecords.map((r) => r.durationMs).sort((a, b) => a - b);
    const successCount = toolRecords.filter((r) => r.success).length;

    return {
      tool,
      count: toolRecords.length,
      successCount,
      failureCount: toolRecords.length - successCount,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p50Ms: this.percentile(durations, 0.5),
      p95Ms: this.percentile(durations, 0.95),
      p99Ms: this.percentile(durations, 0.99),
    };
  }

  /** Get stats for all tools. */
  getAllStats(): LatencyStats[] {
    const tools = new Set(this.records.map((r) => r.tool));
    return Array.from(tools)
      .map((tool) => this.getStats(tool)!)
      .filter(Boolean);
  }

  /** Get all records. */
  getRecords(): readonly LatencyRecord[] {
    return this.records;
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
