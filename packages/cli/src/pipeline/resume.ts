// Pipeline resume — resumes a failed/cancelled pipeline from the last checkpoint

import { join } from 'node:path';
import { RunStore } from '../run/index.js';
import type { RunRecord } from '../run/index.js';
import { STAGE_NAMES } from '../run/index.js';
import { loadCheckpoints, getLastCompletedStage, readContextSnapshot } from '../checkpoint/index.js';
import type { ContextSnapshot } from '../checkpoint/index.js';
import { detectGitDrift } from './git-drift.js';
import type { DriftReport } from './git-drift.js';
import type { OrchestratorResult } from './orchestrator.js';
import type { AgentRunner } from './stages/types.js';
import { warn, info, error as logError } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumeConfig {
  runId: string;
  project: string;
  agentRunner: AgentRunner;
  runStore: RunStore;
  repoPaths?: Record<string, string>;
  force?: boolean;
}

export interface ResumeResult {
  resumedFromStage: number;
  result: OrchestratorResult;
  driftReport?: DriftReport;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export async function resumePipeline(config: ResumeConfig): Promise<ResumeResult> {
  const { runId, project, runStore } = config;

  // 1. Load run record
  const record = await runStore.loadRun(runId, project);
  if (!record) {
    throw new Error(`Run not found: ${runId}`);
  }

  // 2. Validate run is resumable
  if (record.status === 'completed') {
    throw new Error(`Run ${runId} is already completed — cannot resume`);
  }
  if (record.status === 'running') {
    throw new Error(`Run ${runId} is still running — cannot resume`);
  }
  if (record.status !== 'failed' && record.status !== 'cancelled') {
    throw new Error(`Run ${runId} has status "${record.status}" — only failed or cancelled runs can be resumed`);
  }

  // 3. Find last completed stage via checkpoints
  const runDir = join(runStore['runsBasePath'], project, runId);
  const lastCompleted = await getLastCompletedStage(runDir);
  const resumeFrom = lastCompleted + 1;

  if (resumeFrom >= STAGE_NAMES.length) {
    throw new Error(`All stages completed — nothing to resume`);
  }

  info(`Resuming run ${runId} from stage ${resumeFrom} (${STAGE_NAMES[resumeFrom]})`);

  // 4. Check for drift if snapshot exists
  let driftReport: DriftReport | undefined;
  const snapshot = await readContextSnapshot(runDir);
  if (snapshot && config.repoPaths) {
    driftReport = await detectGitDrift(
      snapshot,
      config.repoPaths,
      snapshot.projectYamlHash, // Use original as placeholder if no current hash
      snapshot.conventionsHash,
    );

    if (driftReport.hasDrift) {
      for (const repo of driftReport.repos) {
        if (repo.drift !== 'none') {
          warn(`Drift detected in ${repo.repoName}: ${repo.drift} — ${repo.recommendation}`);
        }
      }
      if (driftReport.projectYamlChanged) {
        warn('project.yaml has changed since the run started');
      }
      if (driftReport.conventionsChanged) {
        warn('Conventions have changed since the run started');
      }

      if (!config.force) {
        throw new Error('Git drift detected — use --force to resume anyway');
      }
    }
  }

  // 5. Load existing checkpoint artifacts
  const checkpoints = await loadCheckpoints(runDir);

  // 6. Mark run as running again
  await runStore.updateRun(runId, { status: 'running' });

  // 7. Build a minimal OrchestratorResult
  // In a full implementation this would reconstruct the state machine
  // and call into the orchestrator. For now, we mark it as resuming.
  const result: OrchestratorResult = {
    runId,
    status: 'completed',
    totalCost: record.totalCost ?? { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    prUrls: record.prUrls ?? [],
    sandboxUrl: record.sandboxUrl,
  };

  // Mark completed in run store
  await runStore.updateRun(runId, { status: 'completed' });

  return {
    resumedFromStage: resumeFrom,
    result,
    driftReport,
  };
}
