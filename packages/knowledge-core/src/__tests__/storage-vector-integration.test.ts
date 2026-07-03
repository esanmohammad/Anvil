/**
 * P0b — real-LanceDB integration through the storage bundle.
 *
 * The existing retrieval tests inject mock stores, so nothing exercised the
 * actual `resolveStorage().vectors` → LanceDB path. This builds a tiny real
 * table through the bundle (no embedder needed — fake vectors) and round-trips
 * upsert → vectorSearch → stats, proving P0b's wiring is behavior-equivalent
 * to the old `new VectorStore(join(basePath,'lancedb'))`. It also proves the
 * `storage.blob.basePath` override reaches the vector directory.
 *
 * Skips when the LanceDB native binding can't load (CI on other arches handles
 * this via the platform-specific optionalDependency).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveStorage } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig, CodeChunk } from '@esankhan3/anvil-knowledge-core';

const DIM = 8;

const baseConfig: KnowledgeConfig = {
  embedding: { provider: 'openai', dimensions: DIM },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
  autoIndex: true,
};

function chunk(id: string, repo: string, text: string, embedding: number[]): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: `${repo}/f.ts`, repoName: repo, project: 'p',
    startLine: 1, endLine: 2, content: text, contextPrefix: '',
    contextualizedContent: text, language: 'ts', entityType: 'function',
    entityName: id, parentEntity: undefined, tokens: 5, imports: [], exports: [],
    embedding,
  };
}

describe('resolveStorage().vectors — real LanceDB round-trip (P0b wiring)', () => {
  it('upserts + searches through the bundle adapter', async (t) => {
    try {
      await import('@lancedb/lancedb');
    } catch {
      t.skip('lancedb native binding unavailable on this platform');
      return;
    }

    const base = join(tmpdir(), `kc-vec-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      const storage = resolveStorage('p', { ...baseConfig, storage: { blob: { backend: 'fs', basePath: base } } });
      // override flows to the bundle base + the vector dir lives under it
      assert.equal(storage.basePath, base);

      const v = storage.vectors;
      await v.init({ healCorrupt: true });

      const e1 = new Array(DIM).fill(0); e1[0] = 1;
      const e2 = new Array(DIM).fill(0); e2[1] = 1;
      await v.upsertChunks([chunk('a', 'r1', 'alpha function', e1), chunk('b', 'r1', 'beta function', e2)]);

      assert.equal(await v.hasData(), true);
      assert.equal((await v.getStats())?.rowCount, 2);
      assert.ok(existsSync(join(base, 'lancedb')), 'vectors written under <override>/lancedb');

      // nearest neighbor to e1 is chunk 'a' — the real round-trip proof
      const near = await v.vectorSearch(e1, { limit: 1 });
      assert.equal(near[0]?.chunk.id, 'a');

      // BM25 path works through the bundle (don't assert ranking on a 2-row table)
      const bm = await v.fullTextSearch('beta', 5);
      assert.ok(Array.isArray(bm));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // P1b — a resolved storage.cache builds a bounded LanceDB Session. Proves the
  // `new Session(...)` + connect(uri, opts, session) wiring is accepted by the
  // real native binding and doesn't break the round-trip (local store; the
  // Session path is backend-agnostic, so this also covers the S3 path).
  it('round-trips with a bounded RAM cache Session (storage.cache)', async (t) => {
    try {
      await import('@lancedb/lancedb');
    } catch {
      t.skip('lancedb native binding unavailable on this platform');
      return;
    }

    const base = join(tmpdir(), `kc-vec-cache-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      const storage = resolveStorage('p', {
        ...baseConfig,
        storage: {
          blob: { backend: 'fs', basePath: base },
          cache: { dir: join(base, 'cache'), maxBytes: 64 * 1024 * 1024, mode: 'ram' },
        },
      });
      const v = storage.vectors;
      await v.init({ healCorrupt: true });

      const e1 = new Array(DIM).fill(0); e1[0] = 1;
      const e2 = new Array(DIM).fill(0); e2[1] = 1;
      await v.upsertChunks([chunk('a', 'r1', 'alpha function', e1), chunk('b', 'r1', 'beta function', e2)]);

      assert.equal((await v.getStats())?.rowCount, 2);
      const near = await v.vectorSearch(e1, { limit: 1 });
      assert.equal(near[0]?.chunk.id, 'a');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // P1c — IVF_PQ vector index. Verifies the write-path build gating (skip below
  // minRows, build above) by inspecting listIndices on a fresh connection, and
  // that an nprobes/refineFactor search over the built index still returns the
  // exact nearest neighbor.
  const lanceIndices = async (base: string): Promise<Array<{ columns?: string[] }>> => {
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(join(base, 'lancedb'));
    const tbl = await db.openTable('chunks');
    return tbl.listIndices();
  };
  const hasVectorIndex = (idx: Array<{ columns?: string[] }>) =>
    idx.some((i) => Array.isArray(i.columns) && i.columns.includes('vector'));

  it('ensureVectorIndex skips the build below minRows', async (t) => {
    try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb native binding unavailable'); return; }
    const base = join(tmpdir(), `kc-vec-ivf-skip-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      const storage = resolveStorage('p', {
        ...baseConfig,
        storage: {
          blob: { backend: 'fs', basePath: base },
          vector: { backend: 'lancedb', lancedb: { index: { type: 'ivf_pq', minRows: 1000 } } },
        },
      } as KnowledgeConfig);
      const v = storage.vectors;
      await v.init({ healCorrupt: true });
      const e1 = new Array(DIM).fill(0); e1[0] = 1;
      const e2 = new Array(DIM).fill(0); e2[1] = 1;
      await v.upsertChunks([chunk('a', 'r1', 'alpha', e1), chunk('b', 'r1', 'beta', e2)]);
      await v.ensureVectorIndex(); // 2 rows < minRows 1000 → no-op
      assert.equal(hasVectorIndex(await lanceIndices(base)), false, 'no vector index below minRows');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('ensureVectorIndex builds IVF_PQ above minRows; nprobes/refineFactor search finds the exact NN', async (t) => {
    try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb native binding unavailable'); return; }
    const base = join(tmpdir(), `kc-vec-ivf-build-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      const storage = resolveStorage('p', {
        ...baseConfig,
        storage: {
          blob: { backend: 'fs', basePath: base },
          vector: { backend: 'lancedb', lancedb: { index: {
            type: 'ivf_pq', numPartitions: 4, numSubVectors: 2, minRows: 100, nprobes: 4, refineFactor: 10,
          } } },
        },
      } as KnowledgeConfig);
      const v = storage.vectors;
      await v.init({ healCorrupt: true });

      const rows: Array<CodeChunk & { embedding: number[] }> = [];
      for (let i = 0; i < 600; i++) {
        rows.push(chunk(`r${i}`, 'r1', `fn ${i}`, Array.from({ length: DIM }, () => Math.random())));
      }
      // A distinctive needle far from the [0,1) cloud — refineFactor re-ranks by
      // exact distance, so distance 0 to its own query must rank it top-1.
      const needle = new Array(DIM).fill(9);
      rows.push(chunk('NEEDLE', 'r1', 'the needle', needle));
      await v.upsertChunks(rows);

      await v.ensureVectorIndex(); // 601 ≥ minRows 100 → builds
      assert.equal(hasVectorIndex(await lanceIndices(base)), true, 'IVF_PQ index built on vector column');

      // a second call is idempotent (index already present → no retrain, no throw)
      await v.ensureVectorIndex();

      const near = await v.vectorSearch(needle, { limit: 1 });
      assert.equal(near[0]?.chunk.id, 'NEEDLE');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
