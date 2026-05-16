/**
 * Legacy `pipeline-state.json` checkpoint writer + clearer.
 *
 * Kept in dashboard because the "Interrupted runs" UI reads from this
 * file path via `findInterruptedPipelines` in `pipeline-runner-types.ts`.
 * The canonical checkpoint hook (`attachCheckpointHook` in
 * core-pipeline) writes a separate `~/.anvil/runs/<runId>/checkpoint.json`
 * for cross-process resume; this file is the dashboard-only mirror that
 * powers the sidebar.
 *
 * Both will eventually consolidate behind one source-of-truth. For now
 * this module just isolates the FS write so `pipeline-runner.ts` doesn't
 * own the byte-level shape.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureStoreLike } from '@esankhan3/anvil-core-pipeline';
import type {
  PipelineCheckpoint,
  PipelineConfig,
  PipelineRunState,
} from './pipeline-runner-types.js';

export interface PipelineCheckpointWriterOptions {
  state: PipelineRunState;
  config: PipelineConfig;
  featureStore: FeatureStoreLike;
}

/**
 * Atomically write the current `state` to
 * `<featureDir>/pipeline-state.json`. Creates the directory if needed.
 * Errors are logged but never thrown — checkpointing is a best-effort
 * forensic mirror, not a correctness gate.
 */
export function writePipelineCheckpoint(opts: PipelineCheckpointWriterOptions): void {
  try {
    const featureDir = opts.featureStore.getFeatureDir(opts.config.project, opts.state.featureSlug);
    if (!existsSync(featureDir)) mkdirSync(featureDir, { recursive: true });

    const cp: PipelineCheckpoint = {
      version: 1,
      runId: opts.state.runId,
      project: opts.state.project,
      feature: opts.state.feature,
      featureSlug: opts.state.featureSlug,
      config: {
        model: opts.config.model,
        modelTier: opts.config.modelTier,
        baseBranch: opts.config.baseBranch,
        skipClarify: opts.config.skipClarify,
        skipShip: opts.config.skipShip,
        actionType: opts.config.actionType,
      },
      status: opts.state.status,
      currentStage: opts.state.currentStage,
      stages: opts.state.stages.map((s) => ({
        name: s.name,
        label: s.label,
        status: s.status,
        cost: s.cost,
        error: s.error,
        repos: s.repos.map((r) => ({
          repoName: r.repoName,
          status: r.status,
          cost: r.cost,
          error: r.error,
        })),
      })),
      repoNames: opts.state.repoNames,
      totalCost: opts.state.totalCost,
      startedAt: opts.state.startedAt,
      updatedAt: new Date().toISOString(),
    };

    const path = join(featureDir, 'pipeline-state.json');
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    console.warn('[pipeline] Checkpoint write failed:', err);
  }
}

/**
 * Mark the on-disk checkpoint with the current status (typically
 * 'completed') so `findInterruptedPipelines` doesn't list it as
 * interrupted. Does not delete the file.
 */
export function clearPipelineCheckpoint(opts: PipelineCheckpointWriterOptions): void {
  try {
    const featureDir = opts.featureStore.getFeatureDir(opts.config.project, opts.state.featureSlug);
    const path = join(featureDir, 'pipeline-state.json');
    if (existsSync(path)) {
      const cp = JSON.parse(readFileSync(path, 'utf-8'));
      cp.status = opts.state.status;
      cp.updatedAt = new Date().toISOString();
      writeFileSync(path, JSON.stringify(cp, null, 2), 'utf-8');
    }
  } catch { /* non-critical */ }
}
