import type { AgentRunner } from '../types.js';
import { createFeatureBranches } from './branching.js';
import { buildRepo, type BuildRepoResult } from './build-repo.js';
import { pushFeatureBranches, type PushResult } from './push.js';

export type { BuildRepoConfig, BuildRepoResult } from './build-repo.js';
export type { PushResult } from './push.js';
export type { CommitResult } from './task-committer.js';
export { createFeatureBranches } from './branching.js';
export { buildRepo } from './build-repo.js';
export { commitTask } from './task-committer.js';
export { pushFeatureBranches } from './push.js';

export interface BuildStageConfig {
  runId: string;
  featureSlug: string;
  agentRunner: AgentRunner;
  repoPaths: Record<string, string>;
  taskPlans: Array<{
    project: string;
    repo: string;
    tasks: Array<{ id: string; description: string; files: string[] }>;
  }>;
  projectPrompt: string;
}

export interface BuildStageResult {
  branchName: string;
  repoResults: BuildRepoResult[];
  pushResults: PushResult[];
}

/**
 * Orchestrates the full build stage:
 * 1. Create feature branches in all repos
 * 2. Build each repo (run agent + commit)
 * 3. Push all branches
 */
export async function runBuildStage(config: BuildStageConfig): Promise<BuildStageResult> {
  const { runId, featureSlug, agentRunner, repoPaths, taskPlans, projectPrompt } = config;

  // Step 1: Create feature branches
  const branchMap = await createFeatureBranches(runId, featureSlug, repoPaths);
  const branchName = `anvil/${runId}/${featureSlug}`;

  // Step 2: Build each repo
  const repoResults: BuildRepoResult[] = [];
  for (const plan of taskPlans) {
    const repoPath = repoPaths[plan.repo];
    if (!repoPath) continue;

    const result = await buildRepo({
      repoName: plan.repo,
      repoPath,
      branchName,
      tasks: plan.tasks,
      agentRunner,
      projectPrompt,
    });
    repoResults.push(result);
  }

  // Step 3: Push feature branches
  const pushResults = await pushFeatureBranches(repoPaths, branchName);

  return {
    branchName,
    repoResults,
    pushResults,
  };
}
