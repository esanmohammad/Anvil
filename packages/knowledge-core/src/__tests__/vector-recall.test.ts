/**
 * P1d — IVF_PQ recall gate (ADR §5.5, O-4).
 *
 * Builds a real IVF_PQ index over a clustered synthetic corpus and asserts the
 * approximate search keeps recall@k ≥ 0.98 vs the exact flat baseline
 * (`bypassVectorIndex` on the same table). A seeded PRNG makes the corpus and
 * queries fully deterministic — this is a CI gate, so it must never flake. A
 * regression that stops threading nprobes/refineFactor, or misconfigures
 * numSubVectors, would drop recall below the SLO and fail here.
 *
 * Skips when the LanceDB native binding can't load (handled per-arch via the
 * optionalDependency), like the other real-LanceDB integration tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveStorage, measureRecallAtK } from '@esankhan3/anvil-knowledge-core';
import type { RecallProbe } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig, CodeChunk } from '@esankhan3/anvil-knowledge-core';

const DIM = 32;
const CLUSTERS = 12;
const N = 1500;
const K = 10;
const THRESHOLD = 0.98;

// mulberry32 — small, deterministic PRNG so the corpus is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const baseConfig: KnowledgeConfig = {
  embedding: { provider: 'openai', dimensions: DIM },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
  autoIndex: true,
};

function chunk(id: string, embedding: number[]): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: 'r/f.ts', repoName: 'r', project: 'p', startLine: 1, endLine: 2,
    content: id, contextPrefix: '', contextualizedContent: id, language: 'ts',
    entityType: 'function', entityName: id, parentEntity: undefined, tokens: 3,
    imports: [], exports: [], embedding,
  };
}

describe('P1d — IVF_PQ recall gate (recall@k vs exact flat baseline)', () => {
  it(`keeps recall@${K} ≥ ${THRESHOLD} over a clustered corpus`, async (t) => {
    try {
      await import('@lancedb/lancedb');
    } catch {
      t.skip('lancedb native binding unavailable on this platform');
      return;
    }

    const base = join(tmpdir(), `kc-recall-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      const rand = mulberry32(0xc0ffee);
      // Well-separated cluster centers (range ~100); points = center + small noise.
      const centers = Array.from({ length: CLUSTERS }, () =>
        Array.from({ length: DIM }, () => rand() * 100),
      );
      const near = (c: number): number[] => centers[c].map((v) => v + (rand() - 0.5));

      const rows: Array<CodeChunk & { embedding: number[] }> = [];
      for (let i = 0; i < N; i++) rows.push(chunk(`r${i}`, near(i % CLUSTERS)));

      const storage = resolveStorage('p', {
        ...baseConfig,
        storage: {
          blob: { backend: 'fs', basePath: base },
          vector: { backend: 'lancedb', lancedb: { index: {
            type: 'ivf_pq', numPartitions: CLUSTERS, numSubVectors: 8, minRows: 100, nprobes: 6, refineFactor: 20,
          } } },
        },
      } as KnowledgeConfig);

      const v = storage.vectors;
      await v.init({ healCorrupt: true });
      await v.upsertChunks(rows);
      await v.ensureVectorIndex(); // P1c build path

      // 40 deterministic queries, each a fresh noisy point near a random cluster.
      const queries = Array.from({ length: 40 }, () => near(Math.floor(rand() * CLUSTERS)));

      const report = await measureRecallAtK(v as unknown as RecallProbe, queries, K);
      console.error(`[recall-gate] recall@${K}: mean=${report.meanRecall.toFixed(4)} min=${report.minRecall.toFixed(4)} over ${report.queries} queries`);

      assert.ok(
        report.meanRecall >= THRESHOLD,
        `IVF_PQ recall@${K} = ${report.meanRecall.toFixed(4)} fell below the ${THRESHOLD} SLO`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
