/**
 * HyDE-lite query expander (P6).
 *
 * For natural-language / mixed queries, prepend or substitute the query
 * with one or more LLM-generated hypothetical code snippets that describe
 * the answer the user is looking for. Embedding the hypothesis instead of
 * the question typically improves recall by 10-20% on natural-language
 * code search benchmarks.
 *
 * Disabled by default — the retriever opts in per query via `RetrieveOpts.
 * queryExpansion`. Skipped automatically for `identifier` / `path` /
 * `error-code` classified queries where the raw query is already exact.
 *
 * No vendor LLM SDK — the expander is library-agnostic. The caller passes
 * a `LlmClient` adapter that knows how to one-shot a prompt and return
 * text. The cli / mcp / dashboard can each hand in their own.
 */

import type { QueryClassification } from './query-classifier.js';

export interface LlmClient {
  /** Run a single one-shot prompt and return the text response. */
  oneShot(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

export interface QueryExpansion {
  /** All queries to retrieve against. First element is the original. */
  queries: string[];
  /** Per-query weight for downstream RRF fusion (sum need not equal 1). */
  weights: number[];
}

// Cache: SHA-256(query|classifier-type) → expansion, 10 min LRU.
const expansionCache = new Map<string, { exp: QueryExpansion; ts: number }>();
const CACHE_MAX = 128;
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(query: string, type: string): string {
  return `${type}::${query}`;
}

function getCache(key: string): QueryExpansion | null {
  const e = expansionCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    expansionCache.delete(key);
    return null;
  }
  return e.exp;
}

function setCache(key: string, exp: QueryExpansion): void {
  if (expansionCache.size >= CACHE_MAX) {
    const oldest = expansionCache.keys().next().value;
    if (oldest !== undefined) expansionCache.delete(oldest);
  }
  expansionCache.set(key, { exp, ts: Date.now() });
}

export interface ExpandOpts {
  /** Max alternate queries to add (default: 2). */
  maxVariants?: number;
  /** Override default skip rule. */
  forceExpand?: boolean;
}

const SYSTEM_PROMPT = `You translate a natural-language code search query into 1-3 short hypothetical code snippets that, if found in a repository, would directly answer the query. Output only the snippets — no commentary, no fences. Each snippet must be at most 6 lines.`;

/**
 * Expand a query into N hypothetical-document variants. Returns the
 * original alongside the variants so the caller can run multi-query
 * retrieval and RRF-fuse the results.
 *
 * Skips expansion for identifier-/path-/error-code-typed queries unless
 * `forceExpand` is set, because the LLM tends to drift away from exact
 * symbols the user already named.
 */
export async function expandQuery(
  query: string,
  classification: QueryClassification,
  llm: LlmClient,
  opts?: ExpandOpts,
): Promise<QueryExpansion> {
  const original: QueryExpansion = { queries: [query], weights: [1.0] };
  const skipForType = !opts?.forceExpand
    && (classification.type === 'identifier'
      || classification.type === 'path'
      || classification.type === 'error-code');
  if (skipForType) return original;

  const key = cacheKey(query, classification.type);
  const cached = getCache(key);
  if (cached) return cached;

  const max = Math.max(1, Math.min(3, opts?.maxVariants ?? 2));
  const prompt = `${SYSTEM_PROMPT}\n\nQuery: ${query}\n\nProduce up to ${max} hypothetical code snippets, one per blank-line-separated block.`;
  let response: string;
  try {
    response = await llm.oneShot(prompt, { maxTokens: 400, temperature: 0.2 });
  } catch {
    return original;
  }

  const variants = response
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);

  if (variants.length === 0) return original;

  const exp: QueryExpansion = {
    queries: [query, ...variants],
    // Slightly down-weight the hypothetical variants so we don't drown the
    // original signal in LLM hallucination.
    weights: [1.0, ...variants.map(() => 0.7)],
  };
  setCache(key, exp);
  return exp;
}

/**
 * RRF fuse retrieval results from N expanded queries. Reciprocal-rank
 * fusion with the standard k=60. Caller provides each `rankings` as an
 * array of stable ids in retrieved order; the function returns the fused
 * ranking of unique ids.
 */
export function fuseRrf(rankings: string[][], weights?: number[], k: number = 60): string[] {
  const scores = new Map<string, number>();
  for (let i = 0; i < rankings.length; i++) {
    const ws = weights?.[i] ?? 1.0;
    const list = rankings[i];
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + ws / (k + rank + 1));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
