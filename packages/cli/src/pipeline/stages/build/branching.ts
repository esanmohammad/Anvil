import { createBranch, checkoutBranch } from '../../../git/index.js';

/**
 * Creates a feature branch in each repo and checks it out.
 * Branch name format: anvil/<runId>/<featureSlug>
 */
export async function createFeatureBranches(
  runId: string,
  featureSlug: string,
  repoPaths: Record<string, string>,
): Promise<Record<string, string>> {
  const branchName = `anvil/${runId}/${featureSlug}`;
  const result: Record<string, string> = {};

  for (const [repoName, repoPath] of Object.entries(repoPaths)) {
    await createBranch(repoPath, branchName);
    await checkoutBranch(repoPath, branchName);
    result[repoName] = branchName;
  }

  return result;
}
