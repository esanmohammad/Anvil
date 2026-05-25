/**
 * Vector retrieval — semantic recall over per-memory embeddings stored
 * in LanceDB. Returns `[]` when (a) no embedder is configured, (b)
 * `@lancedb/lancedb` isn't installed, or (c) no memories have been
 * embedded yet. Callers (`hybridSearch`, etc.) blend results into RRF
 * fusion regardless — the absence of vector hits degrades hybrid
 * retrieval gracefully to BM25 + graph.
 */

import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import { getEmbedder } from '../storage/vector-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

export interface VectorOptions {
  namespace?: MemoryNamespace;
  limit?: number;
}

export async function vectorSearch(
  store: HybridMemoryStore,
  query: string,
  opts: VectorOptions = {},
): Promise<Memory[]> {
  const embedder = getEmbedder();
  if (!embedder) return [];
  const vectorStore = store.vectorStore;
  if (!vectorStore) return [];

  let queryVec: number[];
  try {
    queryVec = await embedder(query);
  } catch {
    return [];
  }

  const hits = await vectorStore.search({
    vector: queryVec,
    namespace: opts.namespace,
    limit: opts.limit ?? 20,
  });
  if (hits.length === 0) return [];

  // Hydrate full Memory<T> rows from the SQLite hot index, preserving
  // distance-rank order.
  const out: Memory[] = [];
  for (const hit of hits) {
    const m = store.findById(hit.id);
    if (m) out.push(m);
  }
  return out;
}
