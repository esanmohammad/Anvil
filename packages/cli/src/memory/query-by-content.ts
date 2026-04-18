// Query by content with trigram similarity — Section B.2

import type { MemoryEntry } from './types.js';
import type { MemoryStore } from './memory-store.js';

/**
 * Generate trigrams from a string.
 */
function trigrams(s: string): Set<string> {
  const lower = s.toLowerCase();
  const result = new Set<string>();
  for (let i = 0; i <= lower.length - 3; i++) {
    result.add(lower.slice(i, i + 3));
  }
  return result;
}

/**
 * Compute trigram similarity between two strings (Jaccard index).
 */
export function trigramSimilarity(a: string, b: string): number {
  const triA = trigrams(a);
  const triB = trigrams(b);
  if (triA.size === 0 && triB.size === 0) return 1;
  if (triA.size === 0 || triB.size === 0) return 0;

  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }

  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Query entries by content similarity using trigram matching.
 * Default threshold: 0.3
 */
export function queryByContent(
  store: MemoryStore,
  search: string,
  threshold: number = 0.3,
): MemoryEntry[] {
  const entries = store.list();

  const scored = entries
    .map((e) => ({ entry: e, score: trigramSimilarity(search, e.content) }))
    .filter((item) => item.score >= threshold);

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.entry);
}
