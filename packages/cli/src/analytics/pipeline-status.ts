// Pipeline status collector — Wave 9, Section D
// Scans run records to find running pipelines

import type { RunRecord } from '../run/types.js';

export interface PipelineStatusEntry {
  runId: string;
  project: string;
  feature: string;
  status: string;
  currentStage: string;
  startedAt: string;
  elapsedMs: number;
}

/**
 * Collect status of all active (running/pending) pipelines from run records.
 */
export function collectPipelineStatus(runs: RunRecord[]): PipelineStatusEntry[] {
  const now = Date.now();
  const entries: PipelineStatusEntry[] = [];

  for (const run of runs) {
    if (run.status !== 'running' && run.status !== 'pending') continue;

    // Find the current active stage
    const activeStage = run.stages.find((s) => s.status === 'running');
    const currentStage = activeStage?.name ?? 'initializing';

    entries.push({
      runId: run.id,
      project: run.project,
      feature: run.feature,
      status: run.status,
      currentStage,
      startedAt: run.createdAt,
      elapsedMs: now - new Date(run.createdAt).getTime(),
    });
  }

  // Sort by most recently started
  entries.sort((a, b) => b.elapsedMs - a.elapsedMs);

  return entries;
}
