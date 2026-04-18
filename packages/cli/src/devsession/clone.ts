import type { Repo } from '../project/types.js';

export type GitProtocol = 'ssh' | 'https';

export type DirtyStrategy = 'skip' | 'stash' | 'commit-push' | 'reset';

export type CloneAction = 'cloned' | 'updated' | 'skipped' | 'failed';

export interface CloneResult {
  repoName: string;
  action: CloneAction;
  error?: Error;
}

export interface DirtyRepo {
  name: string;
  dir: string;
  fileCount: number;
  files: string[];
}

export interface CommandRunner {
  run(cmd: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }>;
}

export function gitURL(github: string, protocol: GitProtocol): string {
  if (protocol === 'ssh') {
    return `git@github.com:${github}.git`;
  }
  return `https://github.com/${github}.git`;
}

export function deduplicateRepos(repos: Repo[]): Repo[] {
  const seen = new Set<string>();
  return repos.filter((r) => {
    const key = r.github.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function cloneOrUpdateRepos(
  runner: CommandRunner,
  repos: Repo[],
  workspaceDir: string,
  protocol: GitProtocol = 'ssh',
  strategy: DirtyStrategy = 'skip',
): Promise<CloneResult[]> {
  const dedupedRepos = deduplicateRepos(repos);
  const results: CloneResult[] = [];

  for (const repo of dedupedRepos) {
    const repoDir = `${workspaceDir}/${repo.name}`;
    const url = gitURL(repo.github, protocol);

    try {
      // Check if already cloned
      try {
        await runner.run('git', ['status', '--porcelain'], repoDir);
        // Repo exists, check if dirty
        const { stdout } = await runner.run('git', ['status', '--porcelain'], repoDir);
        if (stdout.trim()) {
          // Dirty repo
          switch (strategy) {
            case 'skip':
              results.push({ repoName: repo.name, action: 'skipped' });
              continue;
            case 'stash':
              await runner.run('git', ['stash'], repoDir);
              await runner.run('git', ['pull', '--rebase'], repoDir);
              await runner.run('git', ['stash', 'pop'], repoDir);
              break;
            case 'commit-push':
              await runner.run('git', ['add', '-A'], repoDir);
              await runner.run('git', ['commit', '-m', 'WIP: auto-commit before update'], repoDir);
              await runner.run('git', ['push'], repoDir);
              await runner.run('git', ['pull', '--rebase'], repoDir);
              break;
            case 'reset':
              await runner.run('git', ['fetch', 'origin'], repoDir);
              await runner.run('git', ['reset', '--hard', 'origin/HEAD'], repoDir);
              break;
          }
          results.push({ repoName: repo.name, action: 'updated' });
        } else {
          // Clean repo — just pull
          await runner.run('git', ['pull', '--rebase'], repoDir);
          results.push({ repoName: repo.name, action: 'updated' });
        }
      } catch {
        // Repo doesn't exist — clone
        await runner.run('git', ['clone', url, repoDir]);
        results.push({ repoName: repo.name, action: 'cloned' });
      }
    } catch (err) {
      results.push({ repoName: repo.name, action: 'failed', error: err as Error });
    }
  }

  return results;
}

export async function ensureProjectConfig(
  runner: CommandRunner,
  localPath: string,
  repoSlug: string,
  protocol: GitProtocol = 'ssh',
): Promise<void> {
  try {
    await runner.run('git', ['status'], localPath);
    // Exists — pull
    await runner.run('git', ['pull', '--rebase'], localPath);
  } catch {
    // Missing — clone
    const url = gitURL(repoSlug, protocol);
    await runner.run('git', ['clone', url, localPath]);
  }
}
