/**
 * Hash-based dedupe for sleeptime ratification (Phase 10 — plan §10.2.3).
 *
 * Strategy:
 *   1. Cheap hash (`contentDigest`) over the candidate's content+tags. Two
 *      proposals with the same digest are treated as definite duplicates.
 *   2. BM25 nearest-neighbor search over durable memories. The top hit's
 *      content-digest is compared; if it matches, the proposal merges into
 *      the existing memory.
 *
 * The full LLM tie-breaker (plan §10.2.dedupe.ts step 3) lands when
 * memory-core gets a LanguageModel registry. For now `findNearestDuplicate`
 * exposes the BM25 candidate so the consolidator's caller can plug in an
 * LLM judge if desired.
 */

import { createHash } from 'node:crypto';
import { bm25Search } from '../retrieve/bm25.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type { Memory, MemoryNamespace } from '../types.js';

/** Stable digest over the textual signature of a memory. */
export function contentDigest(m: Memory): string {
  const text =
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  const tagPart = [...(m.tags ?? [])].sort().join('|');
  return createHash('sha256').update(`${text}\n${tagPart}`).digest('hex');
}

export interface NearestDuplicate {
  memory: Memory;
  /** True iff the BM25 winner has the same content digest. */
  exact: boolean;
  /**
   * Token-level Jaccard similarity between candidate and top BM25 hit on
   * normalized words. 0.0 = no overlap, 1.0 = identical tokens. Used by
   * `llmDedupeDecide` to gate the LLM judge invocation: similarity above
   * threshold but below `exact` is the only case where a judge call
   * earns its cost.
   */
  similarity: number;
}

export function findNearestDuplicate(
  store: HybridMemoryStore,
  candidate: Memory,
  opts: { namespace?: MemoryNamespace; limit?: number } = {},
): NearestDuplicate | null {
  const text =
    typeof candidate.content === 'string'
      ? candidate.content
      : JSON.stringify(candidate.content);
  if (!text.trim()) return null;
  const hits = bm25Search(store, text, {
    namespace: opts.namespace ?? candidate.namespace,
    limit: opts.limit ?? 5,
  });
  if (hits.length === 0) return null;
  const candidateDigest = contentDigest(candidate);
  const top = hits[0];
  return {
    memory: top,
    exact: contentDigest(top) === candidateDigest,
    similarity: jaccardSimilarity(text, asText(top.content)),
  };
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** Tokenize on word boundaries, lowercase, dedupe. */
function tokenize(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3),
  );
}

/** |A ∩ B| / |A ∪ B|, 0 if both empty. */
export function jaccardSimilarity(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  const union = A.size + B.size - intersect;
  return union === 0 ? 0 : intersect / union;
}
