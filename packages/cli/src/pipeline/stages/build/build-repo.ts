import type { AgentRunner } from '../types.js';
import { commitTask } from './task-committer.js';

export interface BuildRepoConfig {
  repoName: string;
  repoPath: string;
  branchName: string;
  tasks: Array<{ id: string; description: string; files: string[] }>;
  agentRunner: AgentRunner;
  projectPrompt: string;
}

export interface BuildRepoResult {
  repoName: string;
  status: 'completed' | 'failed';
  commits: string[];
  error?: string;
}

/**
 * Runs the engineer agent for each task in a repo, then commits.
 */
export async function buildRepo(config: BuildRepoConfig): Promise<BuildRepoResult> {
  const { repoName, repoPath, branchName, tasks, agentRunner, projectPrompt } = config;
  const commits: string[] = [];

  try {
    for (const task of tasks) {
      const userPrompt = [
        `Task: ${task.id} — ${task.description}`,
        `Branch: ${branchName}`,
        `Files to modify: ${task.files.join(', ')}`,
        `Repository: ${repoName}`,
      ].join('\n');

      await agentRunner.run({
        persona: 'engineer',
        projectPrompt,
        userPrompt,
        workingDir: repoPath,
        stage: 'build',
      });

      const result = await commitTask(repoPath, task.id, task.description);
      if (!result.skipped && result.sha) {
        commits.push(result.sha);
      }
    }

    return {
      repoName,
      status: 'completed',
      commits,
    };
  } catch (error) {
    return {
      repoName,
      status: 'failed',
      commits,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
