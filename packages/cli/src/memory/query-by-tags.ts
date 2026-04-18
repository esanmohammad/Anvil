// Query by tags — Section B.1

import type { MemoryEntry } from './types.js';
import type { MemoryStore } from './memory-store.js';

/**
 * Query entries that match any of the given tags.
 * Returns results sorted by confidence descending.
 */
export function queryByTags(store: MemoryStore, tags: string[]): MemoryEntry[] {
  if (!tags.length) return [];

  const entries = store.list();
  const matching = entries.filter((e) =>
    tags.some((tag) => e.tags.includes(tag)),
  );

  return matching.sort((a, b) => b.confidence - a.confidence);
}
