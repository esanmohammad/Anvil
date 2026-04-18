import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface Checkpoint {
  stageId: number;
  stageName: string;
  artifactPaths: string[];
  agentOutputPath?: string;
  timestamp: string;
  checksum: string;
}

export interface CheckpointManifest {
  runId: string;
  checkpoints: Checkpoint[];
  createdAt: string;
  updatedAt: string;
}

export interface ContextSnapshot {
  projectYamlHash: string;
  conventionsHash: string | null;
  memoryHash: string | null;
  repoShas: Record<string, string | null>;
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function createEmptyManifest(runId: string): CheckpointManifest {
  const now = new Date().toISOString();
  return {
    runId,
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
  };
}
