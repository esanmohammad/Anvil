/**
 * Per-namespace subgraph extraction (Phase 9 — plan §9.2.4).
 *
 * Pulls every memory in the namespace plus its outgoing edges so PPR
 * can run over a small, project-scoped graph without scanning the
 * cross-namespace memory_edge table.
 */

import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';
import type { PprAdjacency } from './ppr.js';

export interface NamespaceSubgraph {
  /** Adjacency keyed by source memory id. */
  adjacency: PprAdjacency;
  /** All memories in the namespace, keyed by id. */
  nodes: Map<string, Memory>;
}

export function extractNamespaceSubgraph(
  store: HybridMemoryStore,
  namespace: MemoryNamespace,
): NamespaceSubgraph {
  const memories = store.query(namespace, { includeInvalidated: true });
  const adjacency: PprAdjacency = new Map();
  const nodes = new Map<string, Memory>();

  for (const m of memories) {
    nodes.set(m.id, m);
    if (!m.links || m.links.length === 0) continue;
    adjacency.set(
      m.id,
      m.links.map((l) => ({ target: l.targetId, weight: l.weight })),
    );
  }

  return { adjacency, nodes };
}
