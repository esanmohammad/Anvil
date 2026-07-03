/**
 * Read-perf fix — scalar indexes + parallel graph lookup.
 *
 * Verifies ensureScalarIndexes() builds BTREE/BITMAP indexes on the columns every
 * .filter()/.where() hits, and that the (now-parallel) getChunksByEntity +
 * getChunksByFile return correct results through them. These are the lookups that
 * were full-table-scanning 383k rows per query in production.
 *
 * Skips when the LanceDB native binding can't load (per-arch optionalDependency).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VectorStore } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';

const DIM = 8;

function chunk(id: string, repo: string, file: string, entity: string, emb: number[]): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: file, repoName: repo, project: 'p', startLine: 1, endLine: 2,
    content: id, contextPrefix: '', contextualizedContent: `${entity} ${id}`, language: 'ts',
    entityType: 'function', entityName: entity, parentEntity: undefined, tokens: 3,
    imports: [], exports: [], embedding: emb,
  };
}

describe('VectorStore — scalar indexes + parallel graph lookup (read-perf)', () => {
  it('builds scalar indexes and serves indexed entity/file lookups', async (t) => {
    try {
      await import('@lancedb/lancedb');
    } catch {
      t.skip('lancedb native binding unavailable on this platform');
      return;
    }

    const base = join(tmpdir(), `kc-idx-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      const v = new VectorStore(join(base, 'lancedb'));
      await v.init({ healCorrupt: true });

      // 2 repos × 3 files × 5 entities = 30 rows, each unique by (repo,file,entity).
      const rows: Array<CodeChunk & { embedding: number[] }> = [];
      for (let r = 0; r < 2; r++) {
        for (let f = 0; f < 3; f++) {
          for (let e = 0; e < 5; e++) {
            const emb = new Array(DIM).fill(0); emb[(r + f + e) % DIM] = 1;
            rows.push(chunk(`r${r}-f${f}-e${e}`, `repo${r}`, `repo${r}/file${f}.ts`, `entity${e}`, emb));
          }
        }
      }
      await v.upsertChunks(rows);
      await v.ensureScalarIndexes();

      // listIndices shows a scalar index on each filtered column (+ FTS).
      const lancedb = await import('@lancedb/lancedb');
      const db = await lancedb.connect(join(base, 'lancedb'));
      const tbl = await db.openTable('chunks');
      const cols = new Set((await tbl.listIndices()).flatMap((i: { columns?: string[] }) => i.columns ?? []));
      for (const c of ['repoName', 'project', 'filePath', 'entityName', 'id']) {
        assert.ok(cols.has(c), `expected a scalar index on ${c}`);
      }

      // getChunksByEntity — exact (repo,file,entity) lookup.
      const one = await v.getChunksByEntity([{ repoName: 'repo1', filePath: 'repo1/file2.ts', entityName: 'entity3' }]);
      assert.ok(one.some((s) => s.chunk.id === 'r1-f2-e3'), 'entity lookup hits the right chunk');

      // >20 lookups → multiple batches run concurrently; every lookup resolves.
      const lookups = rows.map((r) => ({ repoName: r.repoName, filePath: r.filePath, entityName: r.entityName }));
      const all = await v.getChunksByEntity(lookups);
      const ids = new Set(all.map((s) => s.chunk.id));
      for (const r of rows) assert.ok(ids.has(r.id), `parallel batches returned ${r.id}`);

      // getChunksByFile through the now-indexed filePath.
      const file = await v.getChunksByFile('repo0', 'repo0/file1.ts');
      assert.equal(file.length, 5, 'all 5 entities of the file returned');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('builds an IVF_FLAT vector index; nprobes search preserves recall vs exact flat', async (t) => {
    try {
      await import('@lancedb/lancedb');
    } catch {
      t.skip('lancedb native binding unavailable on this platform');
      return;
    }
    const base = join(tmpdir(), `kc-ivf-${randomBytes(6).toString('hex')}`);
    mkdirSync(base, { recursive: true });
    try {
      // deterministic seeded corpus — CI gate must not flake.
      let s = 0x1234abcd >>> 0;
      const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const DIMV = 16, CLUSTERS = 16, N = 5000;
      const centers = Array.from({ length: CLUSTERS }, () => Array.from({ length: DIMV }, () => rand() * 100));
      const near = (c: number): number[] => centers[c].map((v) => v + (rand() - 0.5));

      const v = new VectorStore(join(base, 'lancedb'));
      await v.init({ healCorrupt: true });
      const rows: Array<CodeChunk & { embedding: number[] }> = [];
      for (let i = 0; i < N; i++) rows.push(chunk(`v${i}`, 'repo0', 'repo0/f.ts', `e${i}`, near(i % CLUSTERS)));
      await v.upsertChunks(rows);
      await v.ensureVectorIndex({ minRows: 100 }); // 5000 ≥ 100 → builds; ~70 partitions > 40 nprobes ⇒ real pruning

      const lancedb = await import('@lancedb/lancedb');
      const tbl = await (await lancedb.connect(join(base, 'lancedb'))).openTable('chunks');
      const cols = new Set((await tbl.listIndices()).flatMap((i: { columns?: string[] }) => i.columns ?? []));
      assert.ok(cols.has('vector'), 'IVF_FLAT index built on the vector column');

      // recall@10: approx (IVF + nprobes) vs exact (bypassVectorIndex flat) over 40 queries.
      let hit = 0, total = 0;
      for (let q = 0; q < 40; q++) {
        const query = near(Math.floor(rand() * CLUSTERS));
        const approx = new Set((await v.vectorSearch(query, { limit: 10 })).map((s2) => s2.chunk.id));
        // bypassVectorIndex() forces an exact flat scan = ground truth (it's on the
        // VectorQuery branch of search()'s union, hence the cast).
        const exactRows: Array<{ id: string }> = await (tbl.search(query) as unknown as {
          bypassVectorIndex(): { limit(n: number): { toArray(): Promise<Array<{ id: string }>> } };
        }).bypassVectorIndex().limit(10).toArray();
        const exact = exactRows.map((r) => r.id);
        hit += exact.filter((id: string) => approx.has(id)).length;
        total += exact.length;
      }
      const recall = total > 0 ? hit / total : 1;
      console.error(`[ivf-recall] recall@10 = ${recall.toFixed(4)} over 40 queries`);
      assert.ok(recall >= 0.98, `IVF_FLAT recall@10 ${recall.toFixed(4)} below 0.98`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
