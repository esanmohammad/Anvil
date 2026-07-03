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

function chunk(id: string, entityName: string, filePath?: string, repoName?: string): CodeChunk {
  return {
    id,
    filePath: filePath ?? `${id}.ts`,
    repoName: repoName ?? 'r',
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
  searchByEntityName: async (): Promise<ScoredChunk[]> => [],
} as any;

// Stub store where BOTH probabilistic retrievers miss the definition entirely —
// only the indexed entityName lookup can recover it.
const storeMissingDef = {
  vectorSearch: async (): Promise<ScoredChunk[]> => [
    { chunk: adjacent, score: 0.9, source: 'vector' },
  ],
  fullTextSearch: async (): Promise<ScoredChunk[]> => [
    { chunk: adjacent, score: 0.8, source: 'bm25' },
  ],
  searchByEntityName: async (names: string[]): Promise<ScoredChunk[]> =>
    names.includes('CompanySearchResponse')
      ? [{ chunk: exactDef, score: 1, source: 'exact' }]
      : [],
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

  it('recovers a definition missed by BOTH vector and BM25 via the exact tier', async () => {
    const r = new HybridRetriever(storeMissingDef, embedder, null, config, null, null);
    const res = await r.retrieve('CompanySearchResponse', { mode: 'vector+bm25' });
    assert.equal(res.chunks[0].chunk.id, 'exact', 'exact tier must inject + surface the definition');
    assert.ok(res.chunks.some((c) => c.chunk.id === 'adjacent'), 'fused candidates are kept');
  });

  it('applies the exact tier in bm25 mode (search_exact tool path)', async () => {
    const r = new HybridRetriever(storeMissingDef, embedder, null, config, null, null);
    const res = await r.retrieve('CompanySearchResponse', { mode: 'bm25' });
    assert.equal(res.chunks[0].chunk.id, 'exact', 'exact match must lead search_exact results');
  });
});

describe('hybrid fusion — result-surface shaping', () => {
  it('caps chunks per file so one hot file cannot fill the top-K', async () => {
    const hot = ['h1', 'h2', 'h3', 'h4'].map((id, i) => chunk(id, `Hot${i}`, 'hot.ts'));
    const other = chunk('other', 'Other');
    const store = {
      vectorSearch: async (): Promise<ScoredChunk[]> =>
        hot.map((c) => ({ chunk: c, score: 0.9, source: 'vector' as const })),
      fullTextSearch: async (): Promise<ScoredChunk[]> => [
        { chunk: other, score: 0.8, source: 'bm25' },
      ],
      searchByEntityName: async (): Promise<ScoredChunk[]> => [],
    } as any;
    const r = new HybridRetriever(store, embedder, null, config, null, null);
    const res = await r.retrieve('how does it work', { mode: 'vector+bm25' });
    const hotCount = res.chunks.filter((c) => c.chunk.filePath === 'hot.ts').length;
    assert.ok(hotCount <= 2, `expected ≤2 chunks from hot.ts, got ${hotCount}`);
    assert.ok(res.chunks.some((c) => c.chunk.id === 'other'), 'other files still surface');
  });

  it('drops byte-identical vendored copies, keeping the best-ranked one', async () => {
    const copyA = chunk('copyA', 'Dup', 'lib/Dup.php', 'repo-a');
    const copyB = chunk('copyB', 'Dup', 'lib/Dup.php', 'repo-b'); // identical content
    const store = {
      vectorSearch: async (): Promise<ScoredChunk[]> => [
        { chunk: copyA, score: 0.9, source: 'vector' },
        { chunk: copyB, score: 0.8, source: 'vector' },
      ],
      fullTextSearch: async (): Promise<ScoredChunk[]> => [],
      searchByEntityName: async (): Promise<ScoredChunk[]> => [],
    } as any;
    const r = new HybridRetriever(store, embedder, null, config, null, null);
    const res = await r.retrieve('how does dup work', { mode: 'vector+bm25' });
    const dups = res.chunks.filter((c) => c.chunk.content === 'code for Dup');
    assert.equal(dups.length, 1, 'only one identical copy survives');
    assert.equal(dups[0].chunk.id, 'copyA', 'the higher-ranked copy wins');
  });
});

describe('hybrid fusion — graph expansion gating (no reranker)', () => {
  function trackingGraphStore(calls: { seeds: number }) {
    return {
      nodesInFiles: () => { calls.seeds++; return []; },
      resolveNodes: () => { calls.seeds++; return []; },
      neighborsOf: () => [],
      nodeTypes: () => new Map(),
      close: () => {},
    } as any;
  }

  it('skips expansion when the fused pool already fills maxChunks', async () => {
    const calls = { seeds: 0 };
    const r = new HybridRetriever(store, embedder, trackingGraphStore(calls), config, null, null);
    const res = await r.retrieve('CompanySearchResponse', { mode: 'vector+bm25+graph', maxChunks: 1 });
    assert.equal(calls.seeds, 0, 'graph store must not be touched when it cannot surface');
    assert.equal(res.chunks.length, 1);
  });

  it('still expands when the pool cannot fill maxChunks', async () => {
    const calls = { seeds: 0 };
    const r = new HybridRetriever(store, embedder, trackingGraphStore(calls), config, null, null);
    await r.retrieve('CompanySearchResponse', { mode: 'vector+bm25+graph', maxChunks: 10 });
    assert.ok(calls.seeds > 0, 'graph expansion must run when results are scarce');
  });
});
