/**
 * nprobes calibration: the writer picks the fewest IVF probes whose recall@10
 * (vs an exact scan) reaches the target on query-like probes, records it in
 * vector_index.json, and readers search with it. Queries far from the data —
 * as short texts are from code-chunk embeddings — need more probes than
 * queries drawn from the data, so a probe count fit to the latter
 * under-probes. Real LanceDB; skips when the native binding can't load.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  calibrateNprobes, maintainVectorIndex, measureRecallAtK, readVectorIndexHealth, resolveStorage,
} from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk, KnowledgeConfig, RecallProbe } from '@esankhan3/anvil-knowledge-core';

const DIM = 16;
const N = 3000;
const CLUSTERS = 60;

let seed = 7;
const rand = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const centers = Array.from({ length: CLUSTERS }, () => Array.from({ length: DIM }, () => gauss() * 3));
const near = (c: number[]): number[] => c.map((v) => v + gauss());
/** A point well outside the data, in a random direction. */
const far = (): number[] => Array.from({ length: DIM }, () => gauss() * 12);

const rows = (): Array<CodeChunk & { embedding: number[] }> =>
  Array.from({ length: N }, (_, i) => ({
    id: `c${i}`, filePath: 'r/f.ts', repoName: 'r', project: 'p', startLine: 1, endLine: 2,
    content: `c${i}`, contextPrefix: '', contextualizedContent: `c${i}`, language: 'ts', entityType: 'function',
    entityName: `c${i}`, parentEntity: undefined, tokens: 3, imports: [], exports: [],
    embedding: near(centers[i % CLUSTERS]),
  }));

const baseConfig: KnowledgeConfig = {
  embedding: { provider: 'openai', dimensions: DIM },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
  autoIndex: true,
};

async function withIndexedStore(
  t: { skip: (msg: string) => void },
  fn: (storage: ReturnType<typeof resolveStorage>) => Promise<void>,
): Promise<void> {
  try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb native binding unavailable'); return; }
  const base = join(tmpdir(), `kc-nprobes-${randomBytes(6).toString('hex')}`);
  mkdirSync(base, { recursive: true });
  try {
    const storage = resolveStorage('p', { ...baseConfig, storage: { blob: { backend: 'fs', basePath: base } } } as KnowledgeConfig);
    await storage.vectors.init({ healCorrupt: true });
    await storage.vectors.addChunks(rows(), { skipIndex: true });
    await fn(storage);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

describe('nprobes calibration', () => {
  it('returns the fewest probes reaching the target; far queries need more than in-data ones', async (t) => {
    await withIndexedStore(t, async (storage) => {
      const v = storage.vectors;
      const built = await v.ensureVectorIndex({ minRows: 100 });
      assert.equal(built.status, 'built');
      const parts = built.status === 'built' ? built.numPartitions : 0;
      const store = v as unknown as RecallProbe;
      const inData = Array.from({ length: 40 }, (_, i) => near(centers[(i * 7) % CLUSTERS]));
      const farQ = Array.from({ length: 40 }, far);

      const c = await calibrateNprobes(store, farQ, { k: 10, target: 0.95, maxNprobes: parts });
      assert.ok(c.recall >= 0.95, `recall ${c.recall} below target`);
      if (c.nprobes > 1) {
        const below = await calibrateNprobes(store, farQ, { k: 10, target: 0.95, maxNprobes: c.nprobes - 1 });
        assert.ok(below.recall < 0.95, `${c.nprobes - 1} probes already reach the target`);
      }
      const cIn = await calibrateNprobes(store, inData, { k: 10, target: 0.95, maxNprobes: parts });
      assert.ok(c.nprobes > cIn.nprobes, `far queries ${c.nprobes} vs in-data ${cIn.nprobes} probes`);
    });
  });

  it('maintainVectorIndex records the calibrated probes once per training; readers search with them', async (t) => {
    await withIndexedStore(t, async (storage) => {
      const v = storage.vectors;
      const farQ = Array.from({ length: 40 }, far);
      let calls = 0;
      const probes = async () => { calls++; return farQ; };
      const opts = { log: () => {}, minRows: 100, probes };

      const first = await maintainVectorIndex(v, storage.blobs, { ...opts, rowsWritten: N });
      assert.ok(first?.nprobes && first.nprobes > 0, 'nprobes recorded');
      assert.ok((first?.calibratedRecall ?? 0) >= 0.95);
      assert.equal(first?.calibrationQueries, 40);
      assert.equal(calls, 1);

      await maintainVectorIndex(v, storage.blobs, { ...opts, rowsWritten: 0 });
      assert.equal(calls, 1, 'no recalibration without a new training');

      const health = await readVectorIndexHealth(storage.blobs);
      v.setCalibratedNprobes(health?.nprobes);
      const atCalibrated = await measureRecallAtK(v as unknown as RecallProbe, farQ, 10);
      v.setCalibratedNprobes(1);
      const atOne = await measureRecallAtK(v as unknown as RecallProbe, farQ, 10);
      assert.ok(atCalibrated.meanRecall >= 0.95, `reader recall ${atCalibrated.meanRecall}`);
      assert.ok(atCalibrated.meanRecall > atOne.meanRecall);
    });
  });
});
