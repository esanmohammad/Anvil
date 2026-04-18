import { execGit } from './operations.js';

export async function stageAll(repoPath: string): Promise<void> {
  await execGit(repoPath, ['add', '-A']);
}

export async function stageFiles(repoPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await execGit(repoPath, ['add', '--', ...files]);
}

export async function hasChanges(repoPath: string): Promise<boolean> {
  // Check for both staged and unstaged changes
  const { stdout: staged } = await execGit(repoPath, ['diff', '--cached', '--name-only']);
  if (staged.length > 0) return true;

  const { stdout: unstaged } = await execGit(repoPath, ['diff', '--name-only']);
  if (unstaged.length > 0) return true;

  // Check for untracked files
  const { stdout: untracked } = await execGit(repoPath, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  return untracked.length > 0;
}

export async function commit(repoPath: string, message: string): Promise<string | false> {
  // Check if there's anything staged
  const { stdout: staged } = await execGit(repoPath, ['diff', '--cached', '--name-only']);
  if (staged.length === 0) {
    return false;
  }

  await execGit(repoPath, ['commit', '-m', message]);

  // Return the SHA of the new commit
  const { stdout: sha } = await execGit(repoPath, ['rev-parse', 'HEAD']);
  return sha;
}

export async function push(
  repoPath: string,
  branchName: string,
  setUpstream?: boolean,
): Promise<void> {
  const args = ['push'];
  if (setUpstream) {
    args.push('-u', 'origin', branchName);
  } else {
    args.push('origin', branchName);
  }
  await execGit(repoPath, args);
}
