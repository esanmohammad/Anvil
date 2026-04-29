/**
 * Vector retrieval (Phase 8 stub) — semantic recall over per-memory
 * embeddings. The store schema reserves `embedding_id`; sleeptime
 * (Phase 10) will embed memory content via `@anvil/knowledge-core/embedder`
 * and persist into LanceDB. Until then, this module returns an empty
 * array so the hybrid fusion path stays consistent.
 *
 * Why ship a stub now: callers (`hybridSearch`, `injectMemories`) can
 * already wire vector results into RRF fusion without conditionals.
 * When Phase 10 lands, only the body of `vectorSearch` flips on.
 */

import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

export interface VectorOptions {
  namespace?: MemoryNamespace;
  limit?: number;
}

/**
 * Phase 8: returns []. Phase 10 will populate from LanceDB.
 *
 * Marked async even though the stub is synchronous — the LanceDB API
 * is async, so callers should already await this to avoid a churn-y
 * signature change later.
 */
export async function vectorSearch(
  _store: HybridMemoryStore,
  _query: string,
  _opts: VectorOptions = {},
): Promise<Memory[]> {
  return [];
}
