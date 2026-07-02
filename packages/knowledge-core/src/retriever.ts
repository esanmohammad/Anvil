/**
 * Gold Standard Hybrid Retriever — 4-phase pipeline from
 * "Scalable Code Search Architectures" (2026).
 *
 * Phase 1: Vector ⫽ BM25 (parallel retrieval)
 * Phase 2: RRF fusion → single ranked list
 * Phase 3: AST tripartite expansion from top fused seeds → direct chunk lookup
 * Phase 4: Cross-encoder reranking via Ollama (or Cohere/Voyage)
 */

import type { ScoredChunk, RetrievalResult, EmbeddingProvider } from '@esankhan3/anvil-knowledge-core';
import type { VectorStore } from '@esankhan3/anvil-knowledge-core';
import type { GraphStore } from '@esankhan3/anvil-knowledge-core';
import type { Reranker } from '@esankhan3/anvil-knowledge-core';
import type { QueryRouter } from '@esankhan3/anvil-knowledge-core';
import { classifyQuery } from '@esankhan3/anvil-knowledge-core';

export type RetrievalMode = 'vector' | 'bm25' | 'vector+bm25' | 'vector+graph' | 'vector+bm25+graph';

// Query embedding LRU cache — avoids re-embedding repeated queries
const queryEmbeddingCache = new Map<string, { embedding: number[]; timestamp: number }>();
const CACHE_MAX_SIZE = 128;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedEmbedding(query: string): number[] | null {
  const entry = queryEmbeddingCache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    queryEmbeddingCache.delete(query);
    return null;
  }
  return entry.embedding;
}

function cacheEmbedding(query: string, embedding: number[]): void {
  if (queryEmbeddingCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entry
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
  }
  queryEmbeddingCache.set(query, { embedding, timestamp: Date.now() });
}

// Auto repo-routing (WS-8) is OFF by default. At org scale (>10 repos) the
// router hard-filters to ≤60% of repos by *repo-profile* similarity — so a
// distinctive symbol whose defining repo doesn't resemble the query is
// excluded from BOTH vector and BM25 search before retrieval even runs. That
// pre-filter was the dominant exact-symbol recall loss. Callers still scope
// explicitly via `repos`/`repoFilter`; opt the auto-router back in per-deploy.
const AUTO_ROUTE_REPOS =
  process.env.CODE_SEARCH_AUTO_ROUTE === '1' || process.env.CODE_SEARCH_AUTO_ROUTE === 'true';

// RRF rank constant. The TREC default (60) deliberately flattens rank gaps —
// wrong for code search, where the exact definition (found only by BM25, at
// rank 1) must not be outscored by a semantically-adjacent file that merely
// appears in BOTH lists at mid-rank. Smaller k sharpens rank sensitivity.
// Env-tunable without a redeploy.
const RRF_K = Number(process.env.CODE_SEARCH_RRF_K) || 10;

// Cap on chunks per (repo, file) in the result surface. One hot file can fill
// several top-K slots with adjacent chunks — wasted slots at K=5/10, since
// relevance is judged per file. Env-tunable without a redeploy.
const MAX_CHUNKS_PER_FILE = Math.max(1, Number(process.env.CODE_SEARCH_MAX_PER_FILE) || 2);

/**
 * Normalize a repos filter from whatever shape an MCP client sent into a clean
 * `string[]`. Clients pass `repos` inconsistently — a JSON array, a single
 * string, or a comma-joined string — and the query router may return a
 * non-array. Without this, a non-array reached `.map()` and threw
 * "filterRepos.map is not a function", and a scalar silently failed to scope.
 */
function toRepoArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return [];
}

export class HybridRetriever {
  // Expose for testing/debugging
  readonly vectorStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  // System graph is read through the SQLite-backed GraphStore (bounded slice
  // queries) — NOT an in-memory graphology graph. At org scale the graphology
  // graph either didn't exist (only system_graph.sqlite is written) or was
  // multi-GB to load per query; the store keeps graph expansion O(slice).
  readonly graphStore: GraphStore | null;

  constructor(
    vectorStore: VectorStore,
    embedder: EmbeddingProvider,
    graphStore: GraphStore | null,
    private config: {
      maxChunks: number;
      maxTokens: number;
      hybridWeights: { vector: number; bm25: number; graph: number };
    },
    private reranker: Reranker | null = null,
    private queryRouter: QueryRouter | null = null,
  ) {
    this.vectorStore = vectorStore;
    this.embedder = embedder;
    this.graphStore = graphStore;
  }

  /** Release the GraphStore's SQLite connection. Callers that create a retriever
   *  per request (the in-process backend) should call this when done. */
  close(): void {
    try { this.graphStore?.close(); } catch { /* already closed */ }
  }

  async retrieve(
    query: string,
    opts?: {
      repos?: string[];
      repoFilter?: string[];
      maxChunks?: number;
      maxTokens?: number;
      mode?: RetrievalMode;
    },
  ): Promise<RetrievalResult> {
    const maxChunks = opts?.maxChunks ?? this.config.maxChunks;
    const maxTokens = opts?.maxTokens ?? this.config.maxTokens;
    const mode = opts?.mode ?? 'vector+bm25+graph';

    const useVector = mode !== 'bm25';
    const useBm25 = mode === 'bm25' || mode === 'vector+bm25' || mode === 'vector+bm25+graph';
    const useGraph = mode === 'vector+graph' || mode === 'vector+bm25+graph';

    // Query classification (WS-5) — adaptive weights based on query type
    const classification = classifyQuery(query);
    const adaptiveWeights = classification.weights;

    // Repo filter — use query router (WS-8) if no explicit filter.
    // Normalize to a clean string[]: MCP clients pass `repos` inconsistently
    // (array, a single string, or a comma-joined string), and the router may
    // hand back a non-array. Coercing here fixes the `filterRepos.map is not a
    // function` crash and makes repo-scoping behave the same for every tool.
    let filterRepos = toRepoArray(opts?.repoFilter ?? opts?.repos);
    if (AUTO_ROUTE_REPOS && filterRepos.length === 0 && this.queryRouter) {
      try {
        const routeResult = await this.queryRouter.route(query);
        if (routeResult.strategy === 'filtered') {
          filterRepos = toRepoArray(routeResult.repos);
        }
      } catch {
        // Routing failed — search all repos
      }
    }
    const filter = filterRepos.length > 0
      ? `repoName IN (${filterRepos.map((r) => `'${r.replace(/'/g, "''")}'`).join(',')})`
      : undefined;

    // ---------------------------------------------------------------
    // Phase 1 — Parallel retrieval (fetch 50 from each)
    // ---------------------------------------------------------------
    // BM25 needs no embedding, so run it CONCURRENTLY with the embed round-trip
    // (the ~0.5s OpenAI embed dominates single-query latency) rather than after
    // it — the embed latency is hidden behind the FTS query. Vector path embeds
    // (cache-first) then searches, all inside its own promise.
    const vectorPromise: Promise<ScoredChunk[]> = useVector
      ? (async () => {
          let emb = getCachedEmbedding(query);
          if (!emb) {
            emb = await this.embedder.embedSingle(query);
            cacheEmbedding(query, emb);
          }
          return this.vectorStore.vectorSearch(emb, { limit: 50, filter });
        })()
      : Promise.resolve([] as ScoredChunk[]);
    const bm25Promise: Promise<ScoredChunk[]> = useBm25
      ? this.vectorStore.fullTextSearch(query, 50, filter)
      : Promise.resolve([] as ScoredChunk[]);
    // Literal exact-symbol tier — for a bare identifier query, fetch chunks
    // whose entityName equals the query via the BTREE-indexed lookup. Vector
    // and BM25 can BOTH miss an exact definition (its embedding sits far from
    // the bare token's; BM25 buries rare-token files under chattier ones), and
    // the downstream boost can only reorder candidates that were retrieved.
    // Single-source modes return early below and skip fusion, so skip it there.
    const trimmed = query.trim();
    const isBareIdentifier =
      trimmed.length > 0 && !/\s/.test(trimmed) && classification.type !== 'natural-language';
    const exactPromise: Promise<ScoredChunk[]> =
      isBareIdentifier && mode !== 'vector'
        ? this.vectorStore.searchByEntityName([trimmed], 20, filter)
        : Promise.resolve([] as ScoredChunk[]);
    const [vectorResults, bm25Results, exactResults] = await Promise.all([
      vectorPromise,
      bm25Promise,
      exactPromise,
    ]);

    // Single-source shortcuts — no fusion needed
    if (mode === 'vector') {
      const selected = packWithinBudget(diversifyByFile(vectorResults), maxTokens, maxChunks);
      return { chunks: selected, graphContext: '', totalTokens: sumTokens(selected), query };
    }
    if (mode === 'bm25') {
      // Exact-tier candidates lead — this mode backs the search_exact tool,
      // and an entityName equality hit is the most exact evidence available.
      const merged = dedupeExactContent(deduplicateChunks([...exactResults, ...bm25Results]));
      const selected = packWithinBudget(diversifyByFile(merged), maxTokens, maxChunks);
      return { chunks: selected, graphContext: '', totalTokens: sumTokens(selected), query };
    }

    // ---------------------------------------------------------------
    // Phase 2 — RRF fusion FIRST (before graph expansion)
    // ---------------------------------------------------------------
    // Use adaptive weights from query classification, falling back to config defaults
    const wV = adaptiveWeights.vector ?? this.config.hybridWeights.vector;
    const wB = adaptiveWeights.bm25 ?? this.config.hybridWeights.bm25;
    const retrievalSets: ScoredChunk[][] = [];
    const weights: number[] = [];
    if (vectorResults.length > 0) { retrievalSets.push(vectorResults); weights.push(wV); }
    if (bm25Results.length > 0) { retrievalSets.push(bm25Results); weights.push(wB); }
    // Exact tier outweighs both probabilistic sets — entityName equality is
    // stronger evidence than any rank position (and boostExactSymbol pins
    // matching candidates to the front regardless).
    if (exactResults.length > 0) { retrievalSets.push(exactResults); weights.push(1); }

    const fusedRaw = retrievalSets.length > 1
      ? reciprocalRankFusion(retrievalSets, weights, RRF_K)
      : (retrievalSets[0] ?? []);

    // Exact-symbol boost — pin candidates whose entity name equals a bare
    // identifier query to the top. RRF buries the exact definition (found only
    // by BM25) under adjacent files that appear in both lists; with no reranker
    // downstream, this fused order IS the final order.
    const fused = boostExactSymbol(fusedRaw, query, classification.type);

    // Result-surface shaping on the fused ORDER (best-ranked copy survives):
    // drop exact-content duplicates (vendored copies of the same file across
    // repos), then cap chunks-per-file so top-K slots go to distinct files.
    const fusedPool = diversifyByFile(dedupeExactContent(fused)).slice(0, 15);

    // ---------------------------------------------------------------
    // Phase 3 — AST tripartite expansion from fused seeds
    // ---------------------------------------------------------------
    // With no reranker downstream, expansion candidates are appended AFTER the
    // fused pool and can only surface when the pool can't fill maxChunks by
    // itself. Skip the expansion (synchronous SQLite on the event loop)
    // entirely otherwise — it was pure per-query latency.
    let astChunks: ScoredChunk[] = [];
    const graphCanSurface = this.reranker !== null || fusedPool.length < maxChunks;
    if (useGraph && this.graphStore && graphCanSurface) {
      // 3a. Diversified seed selection from FUSED results (not vector-only)
      const seedNodeIds = this.resolveFusedSeeds(fused, 5);

      if (seedNodeIds.length > 0) {
        // 3b. Tripartite expansion: dependencies + dependents + definitions (depth=1)
        const expandedNodeIds = this.tripartiteExpand(seedNodeIds);

        if (expandedNodeIds.length > 0) {
          // 3c. Direct chunk lookup (no BM25 re-search)
          const lookups = expandedNodeIds.map((nodeId) => {
            const parts = nodeId.split('::');
            // "repoName::filePath::entityName" → 3 parts
            if (parts.length >= 3) {
              return { repoName: parts[0], filePath: parts[1], entityName: parts.slice(2).join('::') };
            }
            // "repoName::filePath" → 2 parts (module node)
            return { repoName: parts[0], filePath: parts.slice(1).join('::') };
          });

          astChunks = await this.vectorStore.getChunksByEntity(lookups);
        }
      }
    }

    // ---------------------------------------------------------------
    // Phase 4 — Cross-encoder reranking
    // ---------------------------------------------------------------
    // Combine the shaped fused pool + AST expanded chunks; re-apply the
    // per-file cap since expansion can re-add files already at the cap.
    const candidatePool = diversifyByFile(
      dedupeExactContent(deduplicateChunks([...fusedPool, ...astChunks])),
    );

    let finalChunks: ScoredChunk[];

    if (this.reranker && candidatePool.length > 1) {
      try {
        const documents = candidatePool.map((sc) => sc.chunk.contextualizedContent || sc.chunk.content);
        const ranked = await this.reranker.rerank(query, documents, maxChunks);
        finalChunks = ranked.map((r) => ({
          ...candidatePool[r.index],
          score: r.score,
          source: 'fused' as const,
        }));
      } catch {
        // Reranker failed (Ollama down, timeout) — fall back to RRF order
        finalChunks = candidatePool;
      }
    } else {
      finalChunks = candidatePool;
    }

    // Budget-constrained selection
    const selected = packWithinBudget(finalChunks, maxTokens, maxChunks);

    // Graph context (architecture summary for LLM prompt) is intentionally
    // empty under the GraphStore: it was only consumed by the RAG-eval harness,
    // and at org scale the in-memory graph it was generated from didn't exist
    // (so it was already ''). Retrieval quality comes from the graph EXPANSION
    // above, not this summary string.
    const graphContext = '';

    return {
      chunks: selected,
      graphContext,
      totalTokens: sumTokens(selected),
      query,
    };
  }

  // ---------------------------------------------------------------
  // Seed resolution: map chunk entities to graph node IDs (bounded SQLite
  // lookups — no full-graph scan, which was the org-scale timeout).
  // ---------------------------------------------------------------
  private resolveFusedSeeds(fused: ScoredChunk[], maxSeeds: number): string[] {
    const store = this.graphStore;
    if (!store) return [];
    const seenFiles = new Set<string>();
    const nodeIds: string[] = [];

    for (const sc of fused) {
      if (nodeIds.length >= maxSeeds) break;
      const { repoName, entityName, filePath } = sc.chunk;
      if (!entityName) continue;
      if (seenFiles.has(filePath)) continue; // diversify across files
      seenFiles.add(filePath);

      const baseName = entityName.replace(/\$\d+$/, '');

      // Exact: the entity node in this repo+file (try normalized + original name).
      const exact = store.nodesInFiles(repoName, [filePath], baseName);
      if (exact.length > 0) { nodeIds.push(exact[0]); continue; }
      if (entityName !== baseName) {
        const exactOrig = store.nodesInFiles(repoName, [filePath], entityName);
        if (exactOrig.length > 0) { nodeIds.push(exactOrig[0]); continue; }
      }

      // Fallback: resolve by label within the same repo (indexed query).
      const byLabel = store.resolveNodes(baseName, repoName);
      if (byLabel.length > 0) { nodeIds.push(byLabel[0].key); }
    }

    return nodeIds;
  }

  // ---------------------------------------------------------------
  // Tripartite expansion: dependencies + dependents (definitions follow via
  // chunk lookup). neighborsOf already drops `contains` edges + low-confidence
  // edges, matching the prior in-graph filter.
  // ---------------------------------------------------------------
  private tripartiteExpand(seedNodeIds: string[]): string[] {
    const store = this.graphStore;
    if (!store) return [];
    const expanded = new Set<string>();
    const seedSet = new Set(seedNodeIds);

    for (const seed of seedNodeIds) {
      // 'both' = outgoing (dependencies) + incoming (dependents).
      for (const n of store.neighborsOf(seed, 'both')) {
        if (!seedSet.has(n)) expanded.add(n);
      }
    }
    if (expanded.size === 0) return [];

    // Filter out module/package nodes — we want entity chunks.
    const keys = [...expanded];
    const types = store.nodeTypes(keys);
    return keys.filter((k) => {
      const t = types.get(k);
      return t !== 'module' && t !== 'package';
    });
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

function reciprocalRankFusion(
  resultSets: ScoredChunk[][],
  weights: number[],
  k: number = RRF_K,
): ScoredChunk[] {
  const scoreMap = new Map<string, { chunk: ScoredChunk['chunk']; score: number }>();

  for (let setIdx = 0; setIdx < resultSets.length; setIdx++) {
    const results = resultSets[setIdx];
    const weight = weights[setIdx] ?? 1;

    for (let rank = 0; rank < results.length; rank++) {
      const { chunk } = results[rank];
      const rrfScore = weight * (1 / (k + rank + 1));
      const existing = scoreMap.get(chunk.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(chunk.id, { chunk, score: rrfScore });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(({ chunk, score }) => ({
      chunk,
      score,
      source: 'fused' as const,
    }));
}

// ---------------------------------------------------------------------------
// Exact-symbol boost
// ---------------------------------------------------------------------------

/**
 * For a bare single-token identifier query, move candidates whose entityName
 * exactly matches the query to the front (preserving their relative order).
 * Repairs RRF's under-ranking of exact definitions for symbol lookups. No-op
 * for multi-word / natural-language queries and when nothing matches.
 */
function boostExactSymbol(fused: ScoredChunk[], query: string, type: string): ScoredChunk[] {
  const q = query.trim();
  if (q.length === 0 || /\s/.test(q) || type === 'natural-language') return fused;
  const target = q.toLowerCase();
  const norm = (s?: string) => (s ?? '').replace(/\$\d+$/, '').toLowerCase();
  const exact: ScoredChunk[] = [];
  const rest: ScoredChunk[] = [];
  for (const sc of fused) {
    if (norm(sc.chunk.entityName) === target) exact.push(sc);
    else rest.push(sc);
  }
  return exact.length > 0 ? [...exact, ...rest] : fused;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateChunks(chunks: ScoredChunk[]): ScoredChunk[] {
  const seen = new Set<string>();
  const result: ScoredChunk[] = [];
  for (const sc of chunks) {
    if (seen.has(sc.chunk.id)) continue;
    seen.add(sc.chunk.id);
    result.push(sc);
  }
  return result;
}

/** Drop chunks whose content is byte-identical to an earlier one — vendored
 *  copies of the same file across repos rank as distinct results and waste
 *  top-K slots. Exact equality only: near-duplicates (diverged copies) are
 *  genuinely different files and are kept. */
function dedupeExactContent(chunks: ScoredChunk[]): ScoredChunk[] {
  if (chunks.length <= 1) return chunks;
  const seen = new Set<string>();
  const result: ScoredChunk[] = [];
  for (const sc of chunks) {
    if (seen.has(sc.chunk.content)) continue;
    seen.add(sc.chunk.content);
    result.push(sc);
  }
  return result;
}

/** Cap chunks per (repo, file), preserving order — one hot file must not fill
 *  the top-K with adjacent chunks. */
function diversifyByFile(chunks: ScoredChunk[], cap: number = MAX_CHUNKS_PER_FILE): ScoredChunk[] {
  const counts = new Map<string, number>();
  const result: ScoredChunk[] = [];
  for (const sc of chunks) {
    const key = `${sc.chunk.repoName}::${sc.chunk.filePath}`;
    const n = counts.get(key) ?? 0;
    if (n >= cap) continue;
    counts.set(key, n + 1);
    result.push(sc);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Budget-constrained packing
// ---------------------------------------------------------------------------

function packWithinBudget(chunks: ScoredChunk[], maxTokens: number, maxChunks?: number): ScoredChunk[] {
  const selected: ScoredChunk[] = [];
  let totalTokens = 0;

  for (const sc of chunks) {
    if (maxChunks && selected.length >= maxChunks) break;
    if (totalTokens + sc.chunk.tokens > maxTokens) break;
    selected.push(sc);
    totalTokens += sc.chunk.tokens;
  }

  return selected;
}

function sumTokens(chunks: ScoredChunk[]): number {
  return chunks.reduce((sum, sc) => sum + sc.chunk.tokens, 0);
}
