// Stats aggregator — Wave 9, Section C
// Computes totals, success rate, avg cost, failure breakdown

import type { RunRecord, CostEntry } from '../run/types.js';

export interface StatsFilter {
  project?: string;
  since?: string; // ISO date string
  until?: string; // ISO date string
}

export interface FailureBreakdown {
  stage: string;
  count: number;
  percentage: number;
}

export interface AggregatedStats {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  runningRuns: number;
  successRate: number; // 0-100
  totalCost: CostEntry;
  avgCostPerRun: CostEntry;
  avgDurationMs: number;
  failureBreakdown: FailureBreakdown[];
  projectBreakdown: Map<string, number>;
  recentRuns: RunRecord[];
}

/**
 * Filter runs based on project and date range.
 */
export function filterRuns(runs: RunRecord[], filter?: StatsFilter): RunRecord[] {
  let filtered = [...runs];

  if (filter?.project) {
    filtered = filtered.filter((r) => r.project === filter.project);
  }

  if (filter?.since) {
    const sinceDate = new Date(filter.since).getTime();
    filtered = filtered.filter((r) => new Date(r.createdAt).getTime() >= sinceDate);
  }

  if (filter?.until) {
    const untilDate = new Date(filter.until).getTime();
    filtered = filtered.filter((r) => new Date(r.createdAt).getTime() <= untilDate);
  }

  return filtered;
}

/**
 * Aggregate statistics from a set of run records.
 */
export function aggregateStats(runs: RunRecord[], filter?: StatsFilter): AggregatedStats {
  const filtered = filterRuns(runs, filter);

  const totalRuns = filtered.length;
  const completedRuns = filtered.filter((r) => r.status === 'completed').length;
  const failedRuns = filtered.filter((r) => r.status === 'failed').length;
  const cancelledRuns = filtered.filter((r) => r.status === 'cancelled').length;
  const runningRuns = filtered.filter((r) => r.status === 'running').length;

  const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

  // Total cost
  const totalCost: CostEntry = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  for (const run of filtered) {
    if (run.totalCost) {
      totalCost.inputTokens += run.totalCost.inputTokens;
      totalCost.outputTokens += run.totalCost.outputTokens;
      totalCost.estimatedCost += run.totalCost.estimatedCost;
    }
  }

  // Average cost per run
  const avgCostPerRun: CostEntry = totalRuns > 0
    ? {
        inputTokens: Math.round(totalCost.inputTokens / totalRuns),
        outputTokens: Math.round(totalCost.outputTokens / totalRuns),
        estimatedCost: totalCost.estimatedCost / totalRuns,
      }
    : { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

  // Average duration
  let totalDurationMs = 0;
  let durationCount = 0;
  for (const run of filtered) {
    if (run.createdAt && run.updatedAt && (run.status === 'completed' || run.status === 'failed')) {
      const dur = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
      if (dur > 0) {
        totalDurationMs += dur;
        durationCount++;
      }
    }
  }
  const avgDurationMs = durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0;

  // Failure breakdown by stage
  const stageFailureCounts = new Map<string, number>();
  for (const run of filtered) {
    if (run.status === 'failed') {
      const failedStage = run.stages.find((s) => s.status === 'failed');
      const stageName = failedStage?.name ?? 'unknown';
      stageFailureCounts.set(stageName, (stageFailureCounts.get(stageName) ?? 0) + 1);
    }
  }

  const failureBreakdown: FailureBreakdown[] = [];
  for (const [stage, count] of stageFailureCounts) {
    failureBreakdown.push({
      stage,
      count,
      percentage: failedRuns > 0 ? Math.round((count / failedRuns) * 100) : 0,
    });
  }
  failureBreakdown.sort((a, b) => b.count - a.count);

  // Project breakdown
  const projectBreakdown = new Map<string, number>();
  for (const run of filtered) {
    projectBreakdown.set(run.project, (projectBreakdown.get(run.project) ?? 0) + 1);
  }

  // Recent runs (last 10)
  const recentRuns = [...filtered]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  return {
    totalRuns,
    completedRuns,
    failedRuns,
    cancelledRuns,
    runningRuns,
    successRate,
    totalCost,
    avgCostPerRun,
    avgDurationMs,
    failureBreakdown,
    projectBreakdown,
    recentRuns,
  };
}
