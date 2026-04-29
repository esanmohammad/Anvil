/**
 * BM25 retrieval (Phase 8) — thin namespace-scoped wrapper around
 * `SqliteHotIndex.searchByText` (FTS5 BM25 ordering, set up in Phase 3).
 */

import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

export interface Bm25Options {
  namespace?: MemoryNamespace;
  limit?: number;
}

export function bm25Search(
  store: HybridMemoryStore,
  query: string,
  opts: Bm25Options = {},
): Memory[] {
  if (!query.trim()) return [];
  return store.sqlite.searchByText(query, {
    limit: opts.limit ?? 50,
    namespace: opts.namespace,
  });
}
