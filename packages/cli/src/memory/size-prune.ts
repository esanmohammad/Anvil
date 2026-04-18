// Size-based pruning — Section A.7

import type { MemoryStore } from './memory-store.js';
import { MAX_SIZE_BYTES } from './types.js';

/**
 * Prune store to fit within maxBytes.
 * Removes lowest-confidence entries first.
 * Returns the number of entries removed.
 */
export function pruneBySize(store: MemoryStore, maxBytes: number = MAX_SIZE_BYTES): number {
  let entries = store.list();
  let totalSize = computeSize(entries);

  if (totalSize <= maxBytes) return 0;

  // Sort by confidence ascending (lowest first — remove these first)
  entries.sort((a, b) => a.confidence - b.confidence);

  let removedCount = 0;
  while (totalSize > maxBytes && entries.length > 0) {
    entries.shift();
    removedCount++;
    totalSize = computeSize(entries);
  }

  store.replaceAll(entries);
  return removedCount;
}

function computeSize(entries: unknown[]): number {
  return entries.reduce<number>((acc, e) => acc + Buffer.byteLength(JSON.stringify(e), 'utf-8'), 0);
}
