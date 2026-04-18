import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { computeChecksum, createEmptyManifest } from './types.js';
import type { Checkpoint, CheckpointManifest } from './types.js';

// ---------------------------------------------------------------------------
// Write a checkpoint for a completed stage
// ---------------------------------------------------------------------------

export async function checkpointStage(
  runDir: string,
  stageId: number,
  stageName: string,
  artifact: string,
  agentOutput?: string,
  project?: string,
): Promise<Checkpoint> {
  // Determine artifact path
  const artifactsDir = join(runDir, 'artifacts');
  let artifactRelative: string;

  if (project) {
    artifactRelative = join(stageName, `${project}.md`);
  } else {
    artifactRelative = `${stageName}.md`;
  }

  const artifactAbsolute = join(artifactsDir, artifactRelative);
  await mkdir(join(artifactAbsolute, '..'), { recursive: true });
  await writeFile(artifactAbsolute, artifact, 'utf8');

  // Agent output
  let agentOutputPath: string | undefined;
  if (agentOutput !== undefined) {
    const agentDir = join(runDir, 'agent-output');
    await mkdir(agentDir, { recursive: true });
    const agentFile = `stage-${stageId}.txt`;
    await writeFile(join(agentDir, agentFile), agentOutput, 'utf8');
    agentOutputPath = join('agent-output', agentFile);
  }

  const checksum = computeChecksum(artifact);
  const timestamp = new Date().toISOString();

  const checkpoint: Checkpoint = {
    stageId,
    stageName,
    artifactPaths: [join('artifacts', artifactRelative)],
    ...(agentOutputPath ? { agentOutputPath } : {}),
    timestamp,
    checksum,
  };

  await updateManifest(runDir, checkpoint);

  return checkpoint;
}

// ---------------------------------------------------------------------------
// Update the manifest file
// ---------------------------------------------------------------------------

export async function updateManifest(
  runDir: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const manifestPath = join(runDir, 'manifest.json');
  let manifest: CheckpointManifest;

  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as CheckpointManifest;
  } catch {
    manifest = createEmptyManifest('unknown');
  }

  // Replace existing checkpoint for same stageId, or append
  const idx = manifest.checkpoints.findIndex(
    (c) => c.stageId === checkpoint.stageId,
  );
  if (idx >= 0) {
    manifest.checkpoints[idx] = checkpoint;
  } else {
    manifest.checkpoints.push(checkpoint);
  }

  manifest.updatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}
