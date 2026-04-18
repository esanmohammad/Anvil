import { execGit } from './operations.js';

export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
}

export interface GitStatus {
  clean: boolean;
  changes: FileChange[];
}

function parseStatusCode(code: string): FileChangeStatus {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case '?':
      return 'untracked';
    default:
      return 'modified';
  }
}

export async function getStatus(repoPath: string): Promise<GitStatus> {
  const { stdout } = await execGit(repoPath, ['status', '--porcelain']);

  if (!stdout) {
    return { clean: true, changes: [] };
  }

  const changes: FileChange[] = stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      // Porcelain format: XY filename
      // X = staging area status, Y = working tree status
      const x = line[0];
      const y = line[1];
      const filePath = line.slice(3).trim();

      // Use the most significant status
      let statusChar: string;
      if (x === '?' && y === '?') {
        statusChar = '?';
      } else if (x !== ' ' && x !== '?') {
        statusChar = x;
      } else {
        statusChar = y;
      }

      // Handle renamed files (format: "R  old -> new")
      let finalPath = filePath;
      if (statusChar === 'R' && filePath.includes(' -> ')) {
        finalPath = filePath.split(' -> ')[1];
      }

      return {
        path: finalPath,
        status: parseStatusCode(statusChar),
      };
    });

  return { clean: changes.length === 0, changes };
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await execGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout;
}

export async function getCurrentSha(repoPath: string): Promise<string> {
  const { stdout } = await execGit(repoPath, ['rev-parse', 'HEAD']);
  return stdout;
}

export async function getDiff(repoPath: string, base?: string): Promise<string> {
  const args = ['diff'];
  if (base) {
    args.push(base);
  }
  const { stdout } = await execGit(repoPath, args);
  return stdout;
}

export async function isClean(repoPath: string): Promise<boolean> {
  const status = await getStatus(repoPath);
  return status.clean;
}
