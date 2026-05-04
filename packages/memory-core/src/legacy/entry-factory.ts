// Memory entry factory — Section A.4

import { randomUUID } from 'node:crypto';
import type { MemoryEntry, MemoryKind } from './types.js';
import { DEFAULT_TTL_DAYS } from './types.js';

export interface CreateMemoryOpts {
  confidence?: number;
  source?: string;
  tags?: string[];
  ttlDays?: number;
}

/**
 * Create a new MemoryEntry with auto-generated ID, timestamps, and defaults.
 */
export function createMemoryEntry(
  kind: MemoryKind,
  content: string,
  opts?: CreateMemoryOpts,
): MemoryEntry {
  const now = new Date();
  const ttlDays = opts?.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  return {
    id: randomUUID(),
    kind,
    content,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    confidence: opts?.confidence ?? 50,
    source: opts?.source ?? 'auto',
    tags: opts?.tags ?? [],
  };
}
