import { execSync } from 'node:child_process';
import { extname } from 'node:path';

export interface GitDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
  /** If true, git diff failed — caller should fall back to full re-index */
  fallbackToFull: boolean;
}

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.py', '.rs', '.java', '.php',
  '.rb', '.swift', '.kt', '.cs', '.scala',
  '.c', '.cpp', '.h', '.hpp',
  '.yaml', '.yml', '.json', '.toml', '.xml',
  '.sql', '.graphql', '.proto',
  '.md', '.txt',
]);

function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTS.has(extname(filePath).toLowerCase());
}

function parseNameStatus(output: string): GitDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  if (!output) return { added, modified, deleted, renamed, fallbackToFull: false };

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    const filePath = parts[1];

    if (!filePath || !status) continue;
    if (!isSourceFile(filePath) && status[0] !== 'R' && status[0] !== 'C') continue;

    switch (status[0]) {
      case 'A':
        added.push(filePath);
        break;
      case 'M':
        modified.push(filePath);
        break;
      case 'D':
        deleted.push(filePath);
        break;
      case 'R': {
        const newPath = parts[2];
        if (newPath) {
          renamed.push({ from: filePath, to: newPath });
          if (isSourceFile(filePath)) deleted.push(filePath);
          if (isSourceFile(newPath)) added.push(newPath);
        }
        break;
      }
      case 'C': {
        const copyPath = parts[2];
        if (copyPath && isSourceFile(copyPath)) added.push(copyPath);
        break;
      }
    }
  }

  return { added, modified, deleted, renamed, fallbackToFull: false };
}

function mergeDiffs(a: GitDiff, b: GitDiff, extraAdded: string[]): GitDiff {
  const allAdded = new Set([...a.added, ...b.added, ...extraAdded]);
  const allModified = new Set([...a.modified, ...b.modified]);
  const allDeleted = new Set([...a.deleted, ...b.deleted]);
  const allRenamed = [...a.renamed, ...b.renamed];

  for (const f of allAdded) allModified.delete(f);
  for (const f of [...allAdded]) {
    if (allDeleted.has(f)) {
      allAdded.delete(f);
      allDeleted.delete(f);
      allModified.add(f);
    }
  }

  return {
    added: [...allAdded],
    modified: [...allModified],
    deleted: [...allDeleted],
    renamed: allRenamed,
    fallbackToFull: a.fallbackToFull || b.fallbackToFull,
  };
}

/**
 * Get files changed between a commit and HEAD using git's Merkle DAG.
 * This is O(1) — git already computed the diff internally.
 */
export function getCommittedChanges(repoPath: string, sinceCommit: string): GitDiff {
  try {
    const output = execSync(
      `git diff --name-status ${sinceCommit}..HEAD`,
      { cwd: repoPath, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return parseNameStatus(output);
  } catch {
    return { added: [], modified: [], deleted: [], renamed: [], fallbackToFull: true };
  }
}

/**
 * Get uncommitted changes (staged + unstaged + untracked).
 */
export function getUncommittedChanges(repoPath: string): GitDiff {
  try {
    const staged = execSync('git diff --name-status --cached', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const unstaged = execSync('git diff --name-status', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: repoPath, encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const stagedDiff = parseNameStatus(staged);
    const unstagedDiff = parseNameStatus(unstaged);
    const untrackedFiles = untracked ? untracked.split('\n').filter(f => f && isSourceFile(f)) : [];

    return mergeDiffs(stagedDiff, unstagedDiff, untrackedFiles);
  } catch {
    return { added: [], modified: [], deleted: [], renamed: [], fallbackToFull: false };
  }
}

/**
 * Get ALL changes since last indexed commit, including uncommitted work.
 * Uses git's Merkle DAG for O(1) change detection.
 *
 * If lastIndexedSha is empty or invalid, returns fallbackToFull: true.
 */
export function getAllChanges(repoPath: string, lastIndexedSha: string): GitDiff {
  if (!lastIndexedSha) {
    return { added: [], modified: [], deleted: [], renamed: [], fallbackToFull: true };
  }

  const committed = getCommittedChanges(repoPath, lastIndexedSha);
  if (committed.fallbackToFull) return committed;

  const uncommitted = getUncommittedChanges(repoPath);
  return mergeDiffs(committed, uncommitted, []);
}

/** Convenience: get a flat list of all files that need re-processing */
export function getChangedFilesList(diff: GitDiff): string[] {
  return [...diff.added, ...diff.modified];
}

/** Convenience: get all files that need removal from index */
export function getDeletedFilesList(diff: GitDiff): string[] {
  return [...diff.deleted];
}
