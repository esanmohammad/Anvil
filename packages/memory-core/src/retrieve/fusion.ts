/**
 * Reciprocal Rank Fusion (Phase 8 — plan §8.2.1.fusion).
 *
 * Standard formula: score(d) = Σ_i 1 / (k + rank_i(d)). Larger weight on
 * a per-stream basis (BM25 vs vector vs graph) lets callers dial how
 * much each retriever contributes. Default `k=60` matches the value
 * `@anvil/knowledge-core/retriever.ts` uses for code-search RRF.
 */

import type { Memory } from '../types.js';

export interface RrfStream {
  /** Memories already ranked best-first. */
  results: Memory[];
  /** Weight applied to this stream's contribution. Default 1. */
  weight?: number;
}

export interface FusionOptions {
  /** RRF dampening parameter; larger = flatter. Default 60. */
  k?: number;
  /** Cap the fused output length. */
  limit?: number;
}

export function reciprocalRankFusion(
  streams: RrfStream[],
  opts: FusionOptions = {},
): Memory[] {
  const k = opts.k ?? 60;
  const scores = new Map<string, { memory: Memory; score: number }>();

  for (const stream of streams) {
    const weight = stream.weight ?? 1;
    stream.results.forEach((memory, index) => {
      const rank = index + 1;
      const contribution = weight / (k + rank);
      const existing = scores.get(memory.id);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(memory.id, { memory, score: contribution });
      }
    });
  }

  const ranked = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.memory);
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}
