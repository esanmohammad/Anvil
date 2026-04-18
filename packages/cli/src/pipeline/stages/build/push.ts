import { push, getCurrentBranch } from '../../../git/index.js';

export interface PushResult {
  repoName: string;
  status: 'pushed' | 'skipped' | 'failed';
  error?: string;
}

/**
 * Pushes the feature branch to origin for each repo.
 * Skips repos not on the expected branch.
 */
export async function pushFeatureBranches(
  repoPaths: Record<string, string>,
  branchName: string,
): Promise<PushResult[]> {
  const results: PushResult[] = [];

  for (const [repoName, repoPath] of Object.entries(repoPaths)) {
    try {
      const currentBranch = await getCurrentBranch(repoPath);
      if (currentBranch !== branchName) {
        results.push({
          repoName,
          status: 'skipped',
          error: `Not on expected branch (on ${currentBranch})`,
        });
        continue;
      }

      await push(repoPath, branchName, true);
      results.push({ repoName, status: 'pushed' });
    } catch (error) {
      results.push({
        repoName,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
