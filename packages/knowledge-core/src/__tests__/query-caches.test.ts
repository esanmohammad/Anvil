/**
 * Query caches are LRU: a hit moves the entry to the most-recent end, so a
 * full cache evicts the least recently used query, not the oldest inserted.
 * Covers the retriever's query-embedding cache and the HyDE expansion cache.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HybridRetriever, expandQuery } from '@esankhan3/anvil-knowledge-core';
import type { EmbeddingProvider, LlmClient, QueryClassification } from '@esankhan3/anvil-knowledge-core';

// Mirror CACHE_MAX_SIZE (retriever.ts) and CACHE_MAX (query-expander.ts).
const EMBED_CACHE = 4096;
const EXPANSION_CACHE = 4096;

describe('query-embedding cache (HybridRetriever)', () => {
  it('evicts the least recently used query, keeping one that was hit', async () => {
    const embedded: string[] = [];
    const embedder = {
      name: 'stub',
      dimensions: 3,
      embed: async (t: string[]) => t.map(() => [1, 0, 0]),
      embedSingle: async (q: string) => { embedded.push(q); return [1, 0, 0]; },
    } as unknown as EmbeddingProvider;
    const store = { vectorSearch: async () => [] } as any;
    const r = new HybridRetriever(store, embedder, null, { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 } });
    const q = (i: number) => `lru embed probe ${i}`;
    const search = (i: number) => r.retrieve(q(i), { mode: 'vector' });

    for (let i = 0; i < EMBED_CACHE; i++) await search(i);
    assert.equal(embedded.length, EMBED_CACHE);
    await search(0); // hit: q(0) becomes the most recently used
    assert.equal(embedded.length, EMBED_CACHE, 'a full cache still holds the first query');
    await search(EMBED_CACHE); // one past full: evicts the least recently used, q(1)

    embedded.length = 0;
    await search(0);
    assert.deepEqual(embedded, [], 'the recently hit query survived the eviction');
    await search(1);
    assert.deepEqual(embedded, [q(1)], 'the least recently used query was evicted');
  });
});

describe('query-expansion cache (expandQuery)', () => {
  it('evicts the least recently used query, keeping one that was hit', async () => {
    const asked: string[] = [];
    const llm: LlmClient = {
      oneShot: async (prompt) => { asked.push(prompt); return 'function variant() {}'; },
    };
    const nl: QueryClassification = { type: 'natural-language', weights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, shouldUseTrigram: false, explanation: '' };
    const q = (i: number) => `how does lru expansion probe ${i} work`;
    const expand = (i: number) => expandQuery(q(i), nl, llm);

    for (let i = 0; i < EXPANSION_CACHE; i++) await expand(i);
    assert.equal(asked.length, EXPANSION_CACHE);
    await expand(0); // hit
    assert.equal(asked.length, EXPANSION_CACHE, 'a full cache still holds the first query');
    await expand(EXPANSION_CACHE); // evicts q(1)

    asked.length = 0;
    await expand(0);
    assert.equal(asked.length, 0, 'the recently hit query survived the eviction');
    await expand(1);
    assert.equal(asked.length, 1, 'the least recently used query was evicted');
  });
});
