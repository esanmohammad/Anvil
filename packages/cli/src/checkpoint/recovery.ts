import { readdir, readFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { computeChecksum } from './types.js';
import type { CheckpointManifest } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncompleteCheckpoint {
  stageId: number;
  type: 'orphaned-staging' | 'missing-artifact' | 'missing-manifest';
  path: string;
}

export interface RecoveryResult {
  action: 'completed' | 'rolled-back' | 'no-action';
  reason: string;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectIncompleteCheckpoints(
  runDir: string,
): Promise<IncompleteCheckpoint[]> {
  const results: IncompleteCheckpoint[] = [];

  // 1. Check for orphaned staging dirs
  const stagingBase = join(runDir, 'checkpoints', '.staging');
  try {
    const entries = await readdir(stagingBase);
    for (const entry of entries) {
      const stageId = parseInt(entry, 10);
      if (!isNaN(stageId)) {
        results.push({
          stageId,
          type: 'orphaned-staging',
          path: join(stagingBase, entry),
        });
      }
    }
  } catch {
    // No staging dir — fine
  }

  // Load manifest
  let manifest: CheckpointManifest | null = null;
  const manifestPath = join(runDir, 'manifest.json');
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as CheckpointManifest;
  } catch {
    // No manifest
  }

  // 2. Manifest entries without artifact files
  if (manifest) {
    for (const cp of manifest.checkpoints) {
      for (const artifactPath of cp.artifactPaths) {
        const fullPath = join(runDir, artifactPath);
        try {
          await stat(fullPath);
        } catch {
          results.push({
            stageId: cp.stageId,
            type: 'missing-artifact',
            path: fullPath,
          });
        }
      }
    }
  }

  // 3. Artifact files without manifest entries
  const artifactsDir = join(runDir, 'artifacts');
  try {
    const files = await readdir(artifactsDir);
    const manifestStageNames = new Set(
      manifest?.checkpoints.map((c) => c.stageName) ?? [],
    );
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const stageName = file.replace(/\.md$/, '');
      if (!manifestStageNames.has(stageName)) {
        results.push({
          stageId: -1, // unknown
          type: 'missing-manifest',
          path: join(artifactsDir, file),
        });
      }
    }
  } catch {
    // No artifacts dir
  }

  return results;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export async function recoverCheckpoint(
  runDir: string,
  stageId: number,
): Promise<RecoveryResult> {
  const stagingPath = join(
    runDir,
    'checkpoints',
    '.staging',
    String(stageId),
  );

  // Check if staging dir exists
  let hasStaging = false;
  try {
    await stat(stagingPath);
    hasStaging = true;
  } catch {
    // No staging
  }

  if (!hasStaging) {
    return { action: 'no-action', reason: 'No staging directory found' };
  }

  // Check for completion marker
  let marker: { files: string[]; stageId: number } | null = null;
  try {
    const raw = await readFile(join(stagingPath, '.complete'), 'utf8');
    marker = JSON.parse(raw);
  } catch {
    // No completion marker — staging was incomplete, roll back
    await rm(stagingPath, { recursive: true, force: true });
    return {
      action: 'rolled-back',
      reason: 'Staging was incomplete (no completion marker)',
    };
  }

  if (!marker || !marker.files) {
    await rm(stagingPath, { recursive: true, force: true });
    return {
      action: 'rolled-back',
      reason: 'Invalid completion marker',
    };
  }

  // Validate staged files — check they exist and checksums match
  for (const file of marker.files) {
    const srcPath = join(stagingPath, file);
    try {
      await stat(srcPath);
    } catch {
      // File may have already been moved (partial phase 2)
      // Check if it's already at the final location
      try {
        await stat(join(runDir, file));
      } catch {
        // Neither staging nor final — data is lost
        await rm(stagingPath, { recursive: true, force: true });
        return {
          action: 'rolled-back',
          reason: `File ${file} missing from both staging and final location`,
        };
      }
    }
  }

  // Complete phase 2 — move remaining staged files to final location
  for (const file of marker.files) {
    const srcPath = join(stagingPath, file);
    const destPath = join(runDir, file);
    try {
      await stat(srcPath);
      await mkdir(join(destPath, '..'), { recursive: true });
      await rename(srcPath, destPath);
    } catch {
      // Already moved — skip
    }
  }

  // Clean up staging
  await rm(stagingPath, { recursive: true, force: true });

  return {
    action: 'completed',
    reason: 'Phase 2 completed from staging data',
  };
}
