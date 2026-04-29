/**
 * `pprSearch` — namespace-scoped Personalized PageRank retrieval (Phase 9).
 *
 * Runs PPR over the project's memory subgraph starting from a small set
 * of seed memory ids (typically produced by the LLM "recognition filter"
 * — that filter itself ships with Phase 10 once we have a LanguageModel
 * registry inside memory-core; for now callers pass in their own seeds).
 */

import { personalizedPageRank, type PprOptions } from './ppr.js';
import { extractNamespaceSubgraph } from './subgraph.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

export interface PprSearchOptions extends PprOptions {
  /** Cap on returned memories (post-PPR). */
  limit?: number;
  /** Hide invalidated memories from the result (default true). */
  excludeInvalidated?: boolean;
}

export interface PprSearchResult {
  memories: Memory[];
  /** Score per returned memory id. */
  scores: Map<string, number>;
  iterations: number;
  converged: boolean;
}

export function pprSearch(
  store: HybridMemoryStore,
  namespace: MemoryNamespace,
  seeds: Map<string, number> | string[],
  opts: PprSearchOptions = {},
): PprSearchResult {
  const seedMap =
    Array.isArray(seeds)
      ? new Map<string, number>(seeds.map((id) => [id, 1]))
      : seeds;

  const { adjacency, nodes } = extractNamespaceSubgraph(store, namespace);
  const { scores, iterations, converged } = personalizedPageRank(
    adjacency,
    seedMap,
    opts,
  );

  const excludeInvalidated = opts.excludeInvalidated ?? true;
  const ranked = Array.from(scores.entries())
    .filter(([id]) => nodes.has(id))
    .map(([id, score]) => ({ id, score, memory: nodes.get(id)! }))
    .filter((entry) =>
      excludeInvalidated ? !entry.memory.bitemporal.invalidAt : true,
    )
    .sort((a, b) => b.score - a.score);

  const limited = opts.limit ? ranked.slice(0, opts.limit) : ranked;
  const memories = limited.map((e) => e.memory);
  const scoreMap = new Map<string, number>(limited.map((e) => [e.id, e.score]));

  return { memories, scores: scoreMap, iterations, converged };
}
