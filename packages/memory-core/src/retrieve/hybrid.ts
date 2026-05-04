/**
 * `hybridSearch` — top-level retrieval entry point (Phase 8).
 *
 * Pipeline:
 *   1. BM25 over SQLite FTS5 (always runs).
 *   2. Vector over LanceDB (stub today; populated by Phase 10 sleeptime).
 *   3. 1-hop graph expansion of the BM25 + vector seed sets.
 *   4. Reciprocal Rank Fusion combines the three streams.
 *
 * Streams default to weight 1; callers can override per-stream weights to
 * bias toward keyword vs semantic vs related-via-graph results.
 */

import { bm25Search } from './bm25.js';
import { vectorSearch } from './vector.js';
import { expandNeighbors } from './graph.js';
import { reciprocalRankFusion } from './fusion.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

export interface HybridSearchOptions {
  namespace?: MemoryNamespace;
  /** Per-retriever caps. */
  bm25Limit?: number;
  vectorLimit?: number;
  graphLimit?: number;
  /** Stream weights for fusion; default 1 each. */
  bm25Weight?: number;
  vectorWeight?: number;
  graphWeight?: number;
  /** Final fused result cap. */
  limit?: number;
  /** RRF dampening (default 60). */
  rrfK?: number;
  /** Skip graph expansion entirely. */
  disableGraph?: boolean;
}

export async function hybridSearch(
  store: HybridMemoryStore,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<Memory[]> {
  const bm25Hits = bm25Search(store, query, {
    namespace: opts.namespace,
    limit: opts.bm25Limit ?? 20,
  });

  const vectorHits = await vectorSearch(store, query, {
    namespace: opts.namespace,
    limit: opts.vectorLimit ?? 20,
  });

  const seeds = dedupeById([...bm25Hits, ...vectorHits]);
  const graphHits = opts.disableGraph
    ? []
    : expandNeighbors(store, seeds, { limit: opts.graphLimit ?? 20 });

  return reciprocalRankFusion(
    [
      { results: bm25Hits, weight: opts.bm25Weight ?? 1 },
      { results: vectorHits, weight: opts.vectorWeight ?? 1 },
      { results: graphHits, weight: opts.graphWeight ?? 0.5 },
    ],
    { k: opts.rrfK, limit: opts.limit },
  );
}

function dedupeById(memories: Memory[]): Memory[] {
  const seen = new Set<string>();
  const out: Memory[] = [];
  for (const m of memories) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}
