/**
 * Graph retrieval (Phase 8) — 1-hop neighbor expansion of seed memories.
 * Phase 9 layers Personalized PageRank on top of this for multi-hop scoring.
 */

import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory } from '../types.js';

export interface GraphExpansionOptions {
  /** Filter by edge relation (e.g., 'supersedes', 'derived-from'). */
  relation?: string;
  /** Cap the number of expanded rows. */
  limit?: number;
}

export function expandNeighbors(
  store: HybridMemoryStore,
  seeds: Memory[] | string[],
  opts: GraphExpansionOptions = {},
): Memory[] {
  const ids =
    seeds.length > 0 && typeof seeds[0] === 'string'
      ? (seeds as string[])
      : (seeds as Memory[]).map((m) => m.id);
  if (ids.length === 0) return [];
  return store.neighborsOf(ids, opts);
}
