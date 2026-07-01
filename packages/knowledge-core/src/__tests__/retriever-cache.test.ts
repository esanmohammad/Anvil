/**
 * Read-perf Step 1 — retriever caching.
 *
 * getRetriever() used to rebuild the whole retriever (open LanceDB + SQLite, read
 * every repo's index_meta, load the router) on EVERY query — the dominant serving
 * cost. It's now memoized per (project, embedding-space); invalidateRetriever()
 * drops it so a reindex is picked up. This pins that contract: repeated calls
 * return the SAME instance, and invalidation forces a rebuild.
 *
 * Skips when the LanceDB native binding is unavailable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore, getRetriever, invalidateRetriever } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig, CodeChunk } from '@esankhan3/anvil-knowledge-core';

const DIM = 8;
const config: KnowledgeConfig = {
  embedding: { provider: 'openai', dimensions: DIM },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
  autoIndex: true,
};

function chunk(id: string, emb: number[]): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: 'r/f.ts', repoName: 'r', project: 'p', startLine: 1, endLine: 2,
    content: id, contextPrefix: '', contextualizedContent: id, language: 'ts',
    entityType: 'function', entityName: id, tokens: 3, imports: [], exports: [], embedding: emb,
  };
}

describe('getRetriever — caching + invalidation (read-perf Step 1)', () => {
  it('caches per project and rebuilds after invalidateRetriever', async (t) => {
    try {
      await import('@lancedb/lancedb');
    } catch {
      t.skip('lancedb native binding unavailable on this platform');
      return;
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'kc-retcache-'));
    const prev = process.env.CODE_SEARCH_DATA_DIR;
    process.env.CODE_SEARCH_DATA_DIR = dataDir; // getKnowledgeBasePath('p') → dataDir/p
    try {
      const base = join(dataDir, 'p');
      mkdirSync(base, { recursive: true });
      const vs = new VectorStore(join(base, 'lancedb'));
      await vs.init({ healCorrupt: true });
      const e = new Array(DIM).fill(0); e[0] = 1;
      await vs.upsertChunks([chunk('a', e)]); // create the table so getRetriever can open it

      const r1 = await getRetriever('p', config);
      const r2 = await getRetriever('p', config);
      assert.strictEqual(r1, r2, 'repeated getRetriever returns the SAME cached instance');

      await invalidateRetriever('p');
      const r3 = await getRetriever('p', config);
      assert.notStrictEqual(r1, r3, 'getRetriever rebuilds after invalidateRetriever');
    } finally {
      await invalidateRetriever();
      if (prev === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
      else process.env.CODE_SEARCH_DATA_DIR = prev;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
