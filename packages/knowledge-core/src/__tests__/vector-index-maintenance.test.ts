/**
 * Vector-index lifecycle: planner decisions (pure) + the write-path
 * maintainVectorIndex step against a real LanceDB table — build, counter,
 * retrain at the ratio, legacy (untracked) retrain-once, ratio 0, optimize
 * folding unindexed rows, health record, heal after a lost index.
 *
 * The integration cases skip when the LanceDB native binding can't load.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  planVectorIndex,
  maintainVectorIndex,
  readVectorIndexHealth,
  resolveStorage,
  KnowledgeIndexer,
} from '@esankhan3/anvil-knowledge-core';
import type {
  CodeChunk,
  KnowledgeConfig,
  VectorIndexHealth,
  VectorIndexState,
} from '@esankhan3/anvil-knowledge-core';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const HOUR = 3_600_000;

const indexed = (indexType = 'IVF_FLAT'): VectorIndexState => ({
  rowCount: 1000,
  index: { name: 'vector_idx', indexType, numIndexedRows: 1000, numUnindexedRows: 0 },
});
const meta = (over: Partial<VectorIndexHealth> = {}): VectorIndexHealth => ({
  indexType: 'IVF_FLAT', numPartitions: 10, trainedRows: 100, trainedAt: new Date(NOW - 48 * HOUR).toISOString(),
  rowsAddedSinceTrain: 0, checkedAt: new Date(NOW).toISOString(), ...over,
});
const plan = (m: VectorIndexHealth | null, s: VectorIndexState | null, over: { ratio?: number; rowsWritten?: number; desiredType?: 'IVF_FLAT' | 'IVF_PQ' } = {}) =>
  planVectorIndex(m, s, { ratio: over.ratio ?? 1, rowsWritten: over.rowsWritten ?? 0, desiredType: over.desiredType ?? 'IVF_FLAT', now: NOW });

describe('planVectorIndex', () => {
  it('no table → none; no index → ensure (build when big enough)', () => {
    assert.equal(plan(null, null).action, 'none');
    assert.equal(plan(meta(), { rowCount: 50, index: null }).action, 'ensure');
  });

  it('untracked training (legacy index, no record) → retrain once', () => {
    assert.deepEqual(plan(null, indexed()), { action: 'retrain', reason: 'untracked' });
    assert.deepEqual(plan(meta({ trainedRows: undefined }), indexed()), { action: 'retrain', reason: 'untracked' });
  });

  it('configured index type differs from the live one → retrain', () => {
    assert.deepEqual(plan(meta(), indexed('IVF_FLAT'), { desiredType: 'IVF_PQ' }), { action: 'retrain', reason: 'type-change' });
    // unknown live type string is not treated as a mismatch
    assert.equal(plan(meta(), indexed('unknown'), { desiredType: 'IVF_PQ' }).action, 'none');
  });

  it('growth: retrains once rows since training reach trainedRows × ratio', () => {
    assert.equal(plan(meta({ rowsAddedSinceTrain: 60 }), indexed(), { rowsWritten: 39 }).action, 'none');
    assert.deepEqual(plan(meta({ rowsAddedSinceTrain: 60 }), indexed(), { rowsWritten: 40 }), { action: 'retrain', reason: 'growth' });
    assert.equal(plan(meta({ rowsAddedSinceTrain: 0 }), indexed(), { rowsWritten: 50, ratio: 0.5 }).action, 'retrain');
  });

  it('ratio 0 disables growth + untracked retrains, but not a type change', () => {
    assert.equal(plan(meta({ rowsAddedSinceTrain: 10_000 }), indexed(), { ratio: 0 }).action, 'none');
    assert.equal(plan(null, indexed(), { ratio: 0 }).action, 'none');
    assert.equal(plan(meta(), indexed('IVF_FLAT'), { ratio: 0, desiredType: 'IVF_PQ' }).action, 'retrain');
  });

  it('backs off for 24h after a retrain that started but never finished', () => {
    const due = { rowsAddedSinceTrain: 500 };
    const started = (h: number) => new Date(NOW - h * HOUR).toISOString();
    assert.deepEqual(plan(meta({ ...due, retrainStartedAt: started(1) }), indexed()), { action: 'backoff', reason: 'growth' });
    assert.equal(plan(meta({ ...due, retrainStartedAt: started(25) }), indexed()).action, 'retrain');
    // finished after it started → not a stuck attempt
    assert.equal(
      plan(meta({ ...due, retrainStartedAt: started(2), trainedAt: started(1) }), indexed()).action,
      'retrain',
    );
    // legacy record with a stuck attempt also backs off
    assert.equal(plan({ rowsAddedSinceTrain: 0, checkedAt: '', retrainStartedAt: started(1) }, indexed()).action, 'backoff');
  });
});

// ── real LanceDB ───────────────────────────────────────────────────────────

const DIM = 8;
const baseConfig: KnowledgeConfig = {
  embedding: { provider: 'openai', dimensions: DIM },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
  autoIndex: true,
};

let seed = 0x5eed1234 >>> 0;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
let nextId = 0;
const rows = (n: number): Array<CodeChunk & { embedding: number[] }> =>
  Array.from({ length: n }, () => {
    const id = `c${nextId++}`;
    return {
      id, filePath: 'r1/f.ts', repoName: 'r1', project: 'p', startLine: 1, endLine: 2,
      content: id, contextPrefix: '', contextualizedContent: id, language: 'ts', entityType: 'function',
      entityName: id, parentEntity: undefined, tokens: 3, imports: [], exports: [],
      embedding: Array.from({ length: DIM }, () => rand()),
    };
  });

async function withStore(
  t: { skip: (msg: string) => void },
  fn: (ctx: { base: string; config: KnowledgeConfig; storage: ReturnType<typeof resolveStorage> }) => Promise<void>,
): Promise<void> {
  try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb native binding unavailable'); return; }
  const base = join(tmpdir(), `kc-vidx-${randomBytes(6).toString('hex')}`);
  mkdirSync(base, { recursive: true });
  try {
    const config = { ...baseConfig, storage: { blob: { backend: 'fs', basePath: base } } } as KnowledgeConfig;
    const storage = resolveStorage('p', config);
    await storage.vectors.init({ healCorrupt: true });
    await fn({ base, config, storage });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const quiet = { log: () => {}, minRows: 100 };

describe('maintainVectorIndex — real LanceDB', () => {
  it('below minRows: no index, no record', async (t) => {
    await withStore(t, async ({ storage }) => {
      await storage.vectors.addChunks(rows(50), { skipIndex: true });
      assert.equal(await maintainVectorIndex(storage.vectors, storage.blobs, { ...quiet, rowsWritten: 50 }), null);
      assert.equal(await readVectorIndexHealth(storage.blobs), null);
    });
  });

  it('builds, counts rows since training, retrains at the ratio and resets', async (t) => {
    await withStore(t, async ({ storage }) => {
      const v = storage.vectors;
      await v.addChunks(rows(200), { skipIndex: true });
      const built = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 200 });
      assert.equal(built?.trainedRows, 200);
      assert.equal(built?.numPartitions, 14); // round(√200)
      assert.equal(built?.rowsAddedSinceTrain, 0);
      assert.equal(built?.indexType, 'IVF_FLAT');

      await v.addChunks(rows(100), { skipIndex: true });
      const grown = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 100 });
      assert.equal(grown?.rowsAddedSinceTrain, 100);
      assert.equal(grown?.trainedRows, 200);
      assert.equal(grown?.trainedAt, built?.trainedAt, 'no retrain below the ratio');

      await v.addChunks(rows(100), { skipIndex: true });
      const retrained = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 100 });
      assert.equal(retrained?.trainedRows, 400, 'retrained on the whole table');
      assert.equal(retrained?.numPartitions, 20); // round(√400)
      assert.equal(retrained?.rowsAddedSinceTrain, 0);
      assert.equal(retrained?.retrainStartedAt, undefined);
      assert.deepEqual(await readVectorIndexHealth(storage.blobs), retrained, 'record persisted');
    });
  });

  it('legacy index with no record retrains once, then stays stable', async (t) => {
    await withStore(t, async ({ storage }) => {
      const v = storage.vectors;
      await v.addChunks(rows(300), { skipIndex: true });
      assert.equal((await v.ensureVectorIndex({ minRows: 100 })).status, 'built'); // as ≤ v0.6.2 did — no record

      const first = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 0 });
      assert.equal(first?.trainedRows, 300);
      const second = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 0 });
      assert.equal(second?.trainedAt, first?.trainedAt, 'no second retrain');
    });
  });

  it('ratio 0: grows 5× without retraining; the counter still accumulates', async (t) => {
    await withStore(t, async ({ storage }) => {
      const v = storage.vectors;
      await v.addChunks(rows(200), { skipIndex: true });
      await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 200, ratio: 0 });
      await v.addChunks(rows(800), { skipIndex: true });
      const after = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 800, ratio: 0 });
      assert.equal(after?.trainedRows, 200);
      assert.equal(after?.rowsAddedSinceTrain, 800);
      assert.equal(after?.numUnindexedRows, 0, 'appends still folded in by optimize');
    });
  });

  it('folds unindexed rows on a nothing-new run and reports health via getStats', async (t) => {
    await withStore(t, async ({ storage, config }) => {
      const v = storage.vectors;
      await v.addChunks(rows(200), { skipIndex: true });
      await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 200 });

      // A prior run appended but died before optimize.
      await v.addChunks(rows(30), { skipIndex: true });
      assert.equal((await v.vectorIndexState())?.index?.numUnindexedRows, 30, 'precondition: unindexed tail');

      const health = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 0 });
      assert.equal(health?.numUnindexedRows, 0);
      assert.equal((health?.numIndexedRows ?? 0) + (health?.numUnindexedRows ?? 0), 230);
      assert.ok(health?.checkedAt);

      const stats = await new KnowledgeIndexer().getStats('p', config);
      assert.equal(stats.vectorIndex?.trainedRows, 200);
      assert.equal(stats.vectorIndex?.numUnindexedRows, 0);
    });
  });

  it('keeps the record when the table state is unreadable after optimize', async (t) => {
    await withStore(t, async ({ storage }) => {
      const v = storage.vectors;
      await v.addChunks(rows(200), { skipIndex: true });
      const built = await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 200 });

      // First state read (planning) succeeds; the post-optimize read fails.
      let reads = 0;
      const flaky = Object.create(v) as typeof v;
      flaky.vectorIndexState = async () => {
        if (++reads === 2) throw new Error('transient I/O');
        return v.vectorIndexState();
      };
      const kept = await maintainVectorIndex(flaky, storage.blobs, { ...quiet, rowsWritten: 10 });
      assert.equal(kept?.trainedRows, built?.trainedRows);
      assert.equal(kept?.lastError, 'vector index state unreadable');
      assert.equal((await readVectorIndexHealth(storage.blobs))?.trainedRows, 200, 'record not dropped');
    });
  });

  it('rebuilds and resets the record when the table lost its index', async (t) => {
    await withStore(t, async ({ base, config, storage }) => {
      const v = storage.vectors;
      await v.addChunks(rows(200), { skipIndex: true });
      await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 200 });
      await v.addChunks(rows(50), { skipIndex: true });
      await maintainVectorIndex(v, storage.blobs, { ...quiet, rowsWritten: 50 });

      const lancedb = await import('@lancedb/lancedb');
      const tbl = await (await lancedb.connect(join(base, 'lancedb'))).openTable('chunks');
      await tbl.dropIndex('vector_idx');

      // A fresh writer (next cycle) opens the table at its latest version.
      const next = resolveStorage('p', config);
      await next.vectors.init({ healCorrupt: true });
      const healed = await maintainVectorIndex(next.vectors, next.blobs, { ...quiet, rowsWritten: 0 });
      assert.equal(healed?.trainedRows, 250);
      assert.equal(healed?.rowsAddedSinceTrain, 0);
    });
  });
});
