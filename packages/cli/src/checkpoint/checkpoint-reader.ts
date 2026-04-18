import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeChecksum } from './types.js';
import type { Checkpoint, CheckpointManifest } from './types.js';

// ---------------------------------------------------------------------------
// Load all checkpoints from manifest
// ---------------------------------------------------------------------------

export async function loadCheckpoints(
  runDir: string,
): Promise<Map<number, Checkpoint>> {
  const manifestPath = join(runDir, 'manifest.json');
  let manifest: CheckpointManifest;

  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as CheckpointManifest;
  } catch {
    return new Map();
  }

  const result = new Map<number, Checkpoint>();

  for (const cp of manifest.checkpoints) {
    // Validate checksums by reading primary artifact
    if (cp.artifactPaths.length > 0) {
      try {
        const content = await readFile(
          join(runDir, cp.artifactPaths[0]),
          'utf8',
        );
        const actual = computeChecksum(content);
        if (actual === cp.checksum) {
          result.set(cp.stageId, cp);
        }
        // Corrupt checkpoints are silently excluded
      } catch {
        // Missing artifact — skip
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Get the last completed stage
// ---------------------------------------------------------------------------

export async function getLastCompletedStage(
  runDir: string,
): Promise<number> {
  const checkpoints = await loadCheckpoints(runDir);
  if (checkpoints.size === 0) return -1;
  return Math.max(...checkpoints.keys());
}

// ---------------------------------------------------------------------------
// Read a specific artifact
// ---------------------------------------------------------------------------

export async function getArtifact(
  runDir: string,
  stageName: string,
  project?: string,
): Promise<string | null> {
  const artifactsDir = join(runDir, 'artifacts');
  const fileName = project
    ? join(stageName, `${project}.md`)
    : `${stageName}.md`;

  try {
    return await readFile(join(artifactsDir, fileName), 'utf8');
  } catch {
    return null;
  }
}
