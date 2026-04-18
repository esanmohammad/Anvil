// Top-K selector — Section B.3

import type { MemoryEntry } from './types.js';

/**
 * Deduplicate by ID and return top K entries sorted by confidence descending.
 * Default K = 5.
 */
export function selectTopK(entries: MemoryEntry[], k: number = 5): MemoryEntry[] {
  // Deduplicate by ID (keep first occurrence)
  const seen = new Set<string>();
  const unique: MemoryEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      unique.push(entry);
    }
  }

  // Sort by confidence descending
  unique.sort((a, b) => b.confidence - a.confidence);

  return unique.slice(0, k);
}
