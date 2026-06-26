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
    if (filterRepos.length === 0 && this.queryRouter) {
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
    let queryEmbedding: number[] | null = null;
    if (useVector) {
      // Check embedding cache first (WS-7 optimization)
      queryEmbedding = getCachedEmbedding(query);
      if (!queryEmbedding) {
        queryEmbedding = await this.embedder.embedSingle(query);
        cacheEmbedding(query, queryEmbedding);
      }
    }

    const [vectorResults, bm25Results] = await Promise.all([
      useVector && queryEmbedding
        ? this.vectorStore.vectorSearch(queryEmbedding, { limit: 50, filter })
        : Promise.resolve([] as ScoredChunk[]),
      useBm25
        ? this.vectorStore.fullTextSearch(query, 50, filter)
        : Promise.resolve([] as ScoredChunk[]),
    ]);

    // Single-source shortcuts — no fusion needed
    if (mode === 'vector') {
      const selected = packWithinBudget(vectorResults, maxTokens, maxChunks);
      return { chunks: selected, graphContext: '', totalTokens: sumTokens(selected), query };
    }
    if (mode === 'bm25') {
      const selected = packWithinBudget(bm25Results, maxTokens, maxChunks);
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

    const fused = retrievalSets.length > 1
      ? reciprocalRankFusion(retrievalSets, weights)
      : (retrievalSets[0] ?? []);

    // ---------------------------------------------------------------
    // Phase 3 — AST tripartite expansion from fused seeds
    // ---------------------------------------------------------------
    let astChunks: ScoredChunk[] = [];
    if (useGraph && this.graphStore) {
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
    // Combine top-15 RRF + AST expanded chunks, deduplicate
    const candidatePool = deduplicateChunks([...fused.slice(0, 15), ...astChunks]);

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
  k: number = 60,
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
