/**
 * Phase J — one-shot migration utility for legacy
 * `<featureDir>/pipeline-state.json` checkpoints.
 *
 * The dashboard historically wrote pipeline state to
 * `~/.anvil/features/<project>/<slug>/pipeline-state.json` on every
 * stage transition. The canonical `attachCheckpointHook` (Phase A)
 * writes to `~/.anvil/runs/<runId>/checkpoint.json` instead.
 *
 * `migrateLegacyCheckpoint(featureDir)` reads the legacy file (if
 * present) and returns a `CheckpointSnapshot.shared` payload that the
 * canonical hook can pick up. Returns null when the legacy file is
 * absent or unreadable.
 *
 * Pure: only reads from disk; never writes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LegacyPipelineCheckpoint {
  version: 1;
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: string;
  currentStage: number;
  stages: Array<{
    name: string;
    label: string;
    status: string;
    cost: number;
    error: string | null;
    repos: Array<{
      repoName: string;
      status: string;
      cost: number;
      error: string | null;
    }>;
  }>;
  repoNames: string[];
  totalCost: number;
  startedAt: string;
  updatedAt: string;
  config?: {
    model: string;
    modelTier?: string;
    baseBranch?: string;
    skipClarify?: boolean;
    skipShip?: boolean;
    actionType?: string;
  };
}

/** The shape `CheckpointSnapshot.shared` expects from the legacy file. */
export interface MigratedCheckpointShared {
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: string;
  currentStage: number;
  stages: LegacyPipelineCheckpoint['stages'];
  repoNames: string[];
  totalCost: number;
  startedAt: string;
  updatedAt: string;
  config?: LegacyPipelineCheckpoint['config'];
}

/**
 * One-shot read of the legacy `pipeline-state.json`. Returns `null`
 * when the file is missing or malformed.
 */
export function migrateLegacyCheckpoint(featureDir: string): MigratedCheckpointShared | null {
  const path = join(featureDir, 'pipeline-state.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const cp = JSON.parse(raw) as LegacyPipelineCheckpoint;
    if (cp.version !== 1) return null;
    return {
      runId: cp.runId,
      project: cp.project,
      feature: cp.feature,
      featureSlug: cp.featureSlug,
      status: cp.status,
      currentStage: cp.currentStage,
      stages: cp.stages,
      repoNames: cp.repoNames,
      totalCost: cp.totalCost,
      startedAt: cp.startedAt,
      updatedAt: cp.updatedAt,
      config: cp.config,
    };
  } catch {
    return null;
  }
}
