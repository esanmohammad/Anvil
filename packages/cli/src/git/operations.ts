import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidBranchName } from './branch-name.js';

const execFileAsync = promisify(execFile);

export async function execGit(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: repoPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  // Try symbolic-ref first (works if remote is configured)
  try {
    const { stdout } = await execGit(repoPath, [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      '--short',
    ]);
    // Returns something like "origin/main" — extract branch name
    const parts = stdout.split('/');
    return parts[parts.length - 1];
  } catch {
    // Fallback: check if "main" branch exists
    try {
      await execGit(repoPath, ['rev-parse', '--verify', 'refs/heads/main']);
      return 'main';
    } catch {
      // Check for "master"
      try {
        await execGit(repoPath, ['rev-parse', '--verify', 'refs/heads/master']);
        return 'master';
      } catch {
        return 'main'; // Default fallback
      }
    }
  }
}

export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execGit(repoPath, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createBranch(
  repoPath: string,
  branchName: string,
  baseBranch?: string,
): Promise<string> {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: "${branchName}"`);
  }

  const exists = await branchExists(repoPath, branchName);
  if (exists) {
    throw new Error(
      `Branch "${branchName}" already exists. Use a different name or delete the existing branch.`,
    );
  }

  const base = baseBranch ?? (await getDefaultBranch(repoPath));

  // Create branch from the base
  await execGit(repoPath, ['branch', branchName, base]);

  // Get the SHA of the new branch
  const { stdout: sha } = await execGit(repoPath, ['rev-parse', `refs/heads/${branchName}`]);
  return sha;
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  await execGit(repoPath, ['checkout', branchName]);
}
