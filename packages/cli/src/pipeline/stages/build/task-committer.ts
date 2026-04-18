import { stageAll, commit, hasChanges } from '../../../git/index.js';
import { getCurrentSha } from '../../../git/index.js';

export interface CommitResult {
  sha: string | null;
  skipped: boolean;
  message: string;
}

/**
 * Stages all changes and commits with the [anvil] prefix format.
 * Returns SHA or null if no changes (skipped).
 */
export async function commitTask(
  repoPath: string,
  taskId: string,
  description: string,
): Promise<CommitResult> {
  const changes = await hasChanges(repoPath);
  if (!changes) {
    return {
      sha: null,
      skipped: true,
      message: `No changes to commit for task ${taskId}`,
    };
  }

  const commitMessage = `[anvil] ${taskId}: ${description}`;
  await stageAll(repoPath);
  const sha = await commit(repoPath, commitMessage);

  if (sha === false) {
    return {
      sha: null,
      skipped: true,
      message: `Nothing staged to commit for task ${taskId}`,
    };
  }

  return {
    sha,
    skipped: false,
    message: commitMessage,
  };
}
