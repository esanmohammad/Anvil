/**
 * Write-path cost per index cycle must not grow with the corpus when little
 * changed: the full-text index is built once and kept current by optimize(),
 * and embedded rows reach LanceDB in a few large appends, not one per
 * embedding batch.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VectorStore } from '../vector-store.js';
import type { CodeChunk } from '../types.js';
import { withKbFixture } from './kb-fixture.js';

const base = join(tmpdir(), `index-cycle-${randomBytes(5).toString('hex')}`);
after(() => rmSync(base, { recursive: true, force: true }));

function chunk(id: string, content: string): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: `${id}.ts`, repoName: 'r', project: 'p', startLine: 1, endLine: 3,
    content, contextPrefix: '', contextualizedContent: content, language: 'typescript',
    entityType: 'function', entityName: id, tokens: 10, imports: [], exports: [],
    embedding: [1, 0, 0, 0],
  };
}

async function lanceAvailable(t: { skip: (msg: string) => void }): Promise<boolean> {
  try { await import('@lancedb/lancedb'); return true; } catch { t.skip('lancedb unavailable'); return false; }
}

async function openChunks(dir: string) {
  const lancedb = await import('@lancedb/lancedb');
  return (await lancedb.connect(dir)).openTable('chunks');
}

async function ftsIndexes(dir: string) {
  const t = await openChunks(dir);
  return (await t.listIndices()).filter((i) => i.indexType === 'FTS' && i.columns.includes('contextualizedContent'));
}

describe('full-text index is built once, then kept current incrementally', () => {
  it('ensureFtsIndex leaves an existing index alone (no rebuild, no new table version)', async (t) => {
    if (!(await lanceAvailable(t))) return;
    const dir = join(base, 'noop');
    const store = new VectorStore(dir);
    await store.init();
    await store.addChunks([chunk('a', 'alpha beta'), chunk('b', 'gamma delta')], { skipIndex: true });
    await store.ensureFtsIndex();
    const before = await (await openChunks(dir)).version();
    await store.ensureFtsIndex();
    assert.equal(await (await openChunks(dir)).version(), before, 'second ensureFtsIndex committed nothing');
  });

  it('rows appended after the index are searchable, and optimizeIndexes folds them in (phrases included)', async (t) => {
    if (!(await lanceAvailable(t))) return;
    const dir = join(base, 'incremental');
    const store = new VectorStore(dir);
    await store.init();
    await store.addChunks([chunk('a', 'alpha beta'), chunk('b', 'gamma delta')], { skipIndex: true });
    await store.ensureFtsIndex();
    await store.addChunks([chunk('c', 'failed to render quokka template')], { skipIndex: true });
    await store.ensureFtsIndex();
    assert.deepEqual((await store.fullTextSearch('quokka', 10)).map((s) => s.chunk.id), ['c'], 'unindexed row searchable');

    // The write cycle always optimizes before readers are told to reopen
    // (maintainVectorIndex → bumpIndexGeneration); phrases need indexed positions.
    await store.optimizeIndexes();
    const [idx] = await ftsIndexes(dir);
    const stats = await (await openChunks(dir)).indexStats(idx.name);
    assert.equal(stats?.numUnindexedRows, 0, 'optimize folded the new row into the index');
    assert.deepEqual((await store.fullTextSearch('quokka', 10)).map((s) => s.chunk.id), ['c']);
    assert.deepEqual((await store.phraseSearch('render quokka template', 10)).map((s) => s.chunk.id), ['c']);
  });

  it('an index under another name (older config) is replaced by the current one', async (t) => {
    if (!(await lanceAvailable(t))) return;
    const lancedb = await import('@lancedb/lancedb');
    const dir = join(base, 'legacy');
    const older = new VectorStore(dir);
    await older.init();
    await older.addChunks([chunk('a', 'alpha beta')], { skipIndex: true });
    await (await openChunks(dir)).createIndex('contextualizedContent', {
      config: lancedb.Index.fts({ withPosition: false }), name: 'legacy_fts',
    });
    // An upgraded writer opens the table fresh.
    const store = new VectorStore(dir);
    await store.init();
    await store.ensureFtsIndex();
    const names = (await ftsIndexes(dir)).map((i) => i.name);
    assert.equal(names.length, 1, `exactly one FTS index left, got ${names.join(',')}`);
    assert.notEqual(names[0], 'legacy_fts');
    assert.deepEqual((await store.phraseSearch('alpha beta', 10)).map((s) => s.chunk.id), ['a'], 'positions available');
  });
});

describe('embedded rows are written in large appends', () => {
  it('a full index writes one data file, not one per embedding batch', async (t) => {
    const prevBatch = process.env.CODE_SEARCH_EMBEDDING_BATCH_SIZE;
    process.env.CODE_SEARCH_EMBEDDING_BATCH_SIZE = '2';
    try {
      await withKbFixture(t, async (f) => {
        const fns = Array.from({ length: 30 }, (_, i) => `export function fn${i}(x: number) {\n  return x + ${i};\n}\n`).join('\n');
        f.repo('svc', { 'src/a.ts': fns });
        await f.index();
        const rows = await f.rows();
        assert.ok(rows.length >= 15, `enough chunks to span many batches (${rows.length})`);
        const data = join(process.env.CODE_SEARCH_DATA_DIR!, f.project, 'lancedb', 'chunks.lance', 'data');
        const files = readdirSync(data).filter((n) => n.endsWith('.lance'));
        // One append, plus at most one file from optimize()'s compaction.
        assert.ok(files.length <= 2, `${files.length} data files for ${rows.length} rows in batches of 2`);
      });
    } finally {
      if (prevBatch === undefined) delete process.env.CODE_SEARCH_EMBEDDING_BATCH_SIZE;
      else process.env.CODE_SEARCH_EMBEDDING_BATCH_SIZE = prevBatch;
    }
  });
});
