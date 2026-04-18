import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { computeChecksum } from './types.js';
import type { ContextSnapshot } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Snapshot diff
// ---------------------------------------------------------------------------

export interface SnapshotDiff {
  projectYamlChanged: boolean;
  conventionsChanged: boolean;
  memoryChanged: boolean;
  repoChanges: Record<string, { old: string | null; new: string | null }>;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  return computeChecksum(content);
}

async function getGitSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function captureContextSnapshot(
  projectYamlPath: string,
  conventionsPath: string | null,
  memoryPath: string | null,
  repoPaths: Record<string, string>,
): Promise<ContextSnapshot> {
  const projectYamlHash = await hashFile(projectYamlPath);

  const conventionsHash = conventionsPath
    ? await hashFile(conventionsPath).catch(() => null)
    : null;

  const memoryHash = memoryPath
    ? await hashFile(memoryPath).catch(() => null)
    : null;

  const repoShas: Record<string, string | null> = {};
  for (const [name, path] of Object.entries(repoPaths)) {
    repoShas[name] = await getGitSha(path);
  }

  return {
    projectYamlHash,
    conventionsHash,
    memoryHash,
    repoShas,
    capturedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function writeContextSnapshot(
  runDir: string,
  snapshot: ContextSnapshot,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const filePath = join(runDir, 'context-snapshot.json');
  await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

export async function readContextSnapshot(
  runDir: string,
): Promise<ContextSnapshot | null> {
  const filePath = join(runDir, 'context-snapshot.json');
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as ContextSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export function compareSnapshots(
  a: ContextSnapshot,
  b: ContextSnapshot,
): SnapshotDiff {
  const repoChanges: Record<string, { old: string | null; new: string | null }> = {};

  const allKeys = new Set([
    ...Object.keys(a.repoShas),
    ...Object.keys(b.repoShas),
  ]);

  for (const key of allKeys) {
    const oldVal = a.repoShas[key] ?? null;
    const newVal = b.repoShas[key] ?? null;
    if (oldVal !== newVal) {
      repoChanges[key] = { old: oldVal, new: newVal };
    }
  }

  return {
    projectYamlChanged: a.projectYamlHash !== b.projectYamlHash,
    conventionsChanged: a.conventionsHash !== b.conventionsHash,
    memoryChanged: a.memoryHash !== b.memoryHash,
    repoChanges,
  };
}
