import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Two-phase commit for checkpoint writes
// ---------------------------------------------------------------------------

function stagingDir(runDir: string): string {
  return join(runDir, 'checkpoints', '.staging');
}

function stagePath(runDir: string, stageId: number): string {
  return join(stagingDir(runDir), String(stageId));
}

export async function twoPhaseCommit(
  runDir: string,
  stageId: number,
  writeFn: () => Promise<string[]>,
): Promise<void> {
  const stageDir = stagePath(runDir, stageId);

  // Phase 1 — write to staging
  await mkdir(stageDir, { recursive: true });

  const files = await writeFn();

  // Write a marker so we know staging is complete
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(stageDir, '.complete'),
    JSON.stringify({ files, stageId, timestamp: new Date().toISOString() }),
    'utf8',
  );

  // Phase 2 — move from staging to final location
  for (const file of files) {
    const src = join(stageDir, file);
    const dest = join(runDir, file);
    await mkdir(join(dest, '..'), { recursive: true });
    await rename(src, dest);
  }

  // Clean up staging
  await rm(stageDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

export async function hasIncompleteCheckpoint(
  runDir: string,
): Promise<boolean> {
  const stages = await listIncompleteStages(runDir);
  return stages.length > 0;
}

export async function listIncompleteStages(
  runDir: string,
): Promise<number[]> {
  const dir = stagingDir(runDir);
  try {
    const entries = await readdir(dir);
    return entries
      .map((e) => parseInt(e, 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
