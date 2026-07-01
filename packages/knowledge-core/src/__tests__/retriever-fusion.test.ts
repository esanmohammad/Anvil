/**
 * Read-quality — exact-symbol boost in hybrid fusion.
 *
 * With no reranker (prod config: reranker=none), the RRF-fused order IS the
 * final order. Plain RRF (even weighted toward BM25) buries the exact
 * definition — found only by BM25 at rank 1 — under a semantically-adjacent
 * file that appears in BOTH the vector and BM25 lists. This pins the fix:
 * a bare-identifier query surfaces its exact entityName match first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HybridRetriever } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, ScoredChunk, EmbeddingProvider } from '@esankhan3/anvil-knowledge-core';

function chunk(id: string, entityName: string): CodeChunk {
  return {
    id,
    filePath: `${id}.ts`,
    repoName: 'r',
    project: 'p',
    startLine: 1,
    endLine: 5,
    content: `code for ${entityName}`,
    contextPrefix: '',
    contextualizedContent: `code for ${entityName}`,
    language: 'ts',
    entityType: 'class',
    entityName,
    tokens: 10,
    imports: [],
    exports: [],
  };
}

const adjacent = chunk('adjacent', 'CompanySearchService'); // shows in BOTH lists
const exactDef = chunk('exact', 'CompanySearchResponse');   // BM25-only, the true def

// Stub store: vector finds only the adjacent file; BM25 finds the adjacent file
// at rank 0 and the exact definition at rank 1 (exactly the losing case).
const store = {
  vectorSearch: async (): Promise<ScoredChunk[]> => [
    { chunk: adjacent, score: 0.9, source: 'vector' },
  ],
  fullTextSearch: async (): Promise<ScoredChunk[]> => [
    { chunk: adjacent, score: 0.8, source: 'bm25' },
    { chunk: exactDef, score: 0.7, source: 'bm25' },
  ],
} as any;

const embedder = {
  name: 'stub',
  dimensions: 3,
  embed: async (t: string[]) => t.map(() => [1, 0, 0]),
  embedSingle: async () => [1, 0, 0],
} as unknown as EmbeddingProvider;

const config = { maxChunks: 10, maxTokens: 40000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 } };

describe('hybrid fusion — exact-symbol boost', () => {
  it('surfaces the exact entityName match first for a bare-identifier query', async () => {
    const r = new HybridRetriever(store, embedder, null, config, null, null);
    const res = await r.retrieve('CompanySearchResponse', { mode: 'vector+bm25' });
    assert.equal(res.chunks[0].chunk.id, 'exact', 'exact definition must rank first');
  });

  it('is a no-op for natural-language queries (no false pinning)', async () => {
    const r = new HybridRetriever(store, embedder, null, config, null, null);
    // Adjacent appears in both lists → wins RRF; nothing is force-pinned.
    const res = await r.retrieve('how does company search work', { mode: 'vector+bm25' });
    assert.equal(res.chunks[0].chunk.id, 'adjacent');
  });
});
