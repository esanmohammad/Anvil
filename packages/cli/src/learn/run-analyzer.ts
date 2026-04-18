// Run analyzer — Wave 9, Section E
// Finds patterns in past run history

import type { RunRecord } from '../run/types.js';

export interface RunPattern {
  type: 'frequent-failure' | 'slow-stage' | 'high-cost' | 'retry-needed';
  description: string;
  occurrences: number;
  recommendation: string;
}

/**
 * Analyze past runs to find patterns and recommendations.
 */
export function analyzePastRuns(runs: RunRecord[]): RunPattern[] {
  const patterns: RunPattern[] = [];

  if (runs.length === 0) return patterns;

  // Pattern 1: Frequent failures at specific stages
  const stageFailures = new Map<string, number>();
  for (const run of runs) {
    if (run.status === 'failed') {
      const failedStage = run.stages.find((s) => s.status === 'failed');
      if (failedStage) {
        stageFailures.set(failedStage.name, (stageFailures.get(failedStage.name) ?? 0) + 1);
      }
    }
  }
  for (const [stage, count] of stageFailures) {
    if (count >= 2) {
      patterns.push({
        type: 'frequent-failure',
        description: `Stage "${stage}" fails frequently`,
        occurrences: count,
        recommendation: `Review the "${stage}" stage configuration. Consider adding better error handling or validation.`,
      });
    }
  }

  // Pattern 2: Slow stages
  for (const run of runs) {
    for (const stage of run.stages) {
      if (stage.startedAt && stage.completedAt) {
        const duration = new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime();
        if (duration > 600_000) { // > 10 minutes
          const existing = patterns.find(
            (p) => p.type === 'slow-stage' && p.description.includes(stage.name),
          );
          if (existing) {
            existing.occurrences++;
          } else {
            patterns.push({
              type: 'slow-stage',
              description: `Stage "${stage.name}" takes over 10 minutes`,
              occurrences: 1,
              recommendation: `Consider breaking down the "${stage.name}" stage or optimizing prompts for efficiency.`,
            });
          }
        }
      }
    }
  }

  // Pattern 3: High cost runs
  const costs = runs
    .filter((r) => r.totalCost)
    .map((r) => r.totalCost!.estimatedCost);
  if (costs.length > 0) {
    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
    const highCostRuns = runs.filter(
      (r) => r.totalCost && r.totalCost.estimatedCost > avgCost * 2,
    );
    if (highCostRuns.length >= 2) {
      patterns.push({
        type: 'high-cost',
        description: `${highCostRuns.length} runs cost more than 2x the average`,
        occurrences: highCostRuns.length,
        recommendation: 'Review prompts for verbosity. Consider skipping optional stages for simple features.',
      });
    }
  }

  // Pattern 4: Runs that needed retries (same feature repeated)
  const featureCounts = new Map<string, number>();
  for (const run of runs) {
    const key = `${run.project}:${run.featureSlug}`;
    featureCounts.set(key, (featureCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of featureCounts) {
    if (count >= 3) {
      patterns.push({
        type: 'retry-needed',
        description: `Feature "${key}" was attempted ${count} times`,
        occurrences: count,
        recommendation: 'This feature may need human intervention or a different approach.',
      });
    }
  }

  return patterns;
}
