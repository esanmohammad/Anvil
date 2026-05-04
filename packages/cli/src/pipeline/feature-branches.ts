/**
 * Feature-branch creation — Phase 5 of core-pipeline consolidation.
 *
 * Lifted verbatim from `orchestrator.ts:412-439`. Creates the
 * `anvil/<featureSlug>` branch in every repo before the build stage
 * runs. Idempotent: re-runs check out the existing branch.
 *
 * Note: this is the *outer* feature branch (one per pipeline run).
 * The inner per-task branching used by `runBuildStage` lives in
 * `cli/src/pipeline/stages/build/branching.ts` and is unchanged.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { info, warn } from '../logger.js';

export function createPipelineFeatureBranches(
  featureSlug: string,
  repoPaths: Record<string, string>,
  workspaceDir: string,
  repoNames: string[],
): void {
  const branchName = `anvil/${featureSlug}`;
  info(`Creating feature branch "${branchName}" in all repos...`);

  const targets = repoNames.length > 0
    ? repoNames.map((r) => ({ name: r, path: repoPaths[r] || join(workspaceDir, r) }))
    : [{ name: 'workspace', path: workspaceDir }];

  for (const repo of targets) {
    try {
      try {
        execFileSync('git', ['rev-parse', '--verify', branchName], { cwd: repo.path, stdio: 'pipe' });
        execFileSync('git', ['checkout', branchName], { cwd: repo.path, stdio: 'pipe' });
        info(`Checked out existing branch "${branchName}" in ${repo.name}`);
      } catch {
        execFileSync('git', ['checkout', '-b', branchName], { cwd: repo.path, stdio: 'pipe' });
        info(`Created branch "${branchName}" in ${repo.name}`);
      }
    } catch (err) {
      warn(`Failed to create branch in ${repo.name}: ${err}`);
    }
  }
}
