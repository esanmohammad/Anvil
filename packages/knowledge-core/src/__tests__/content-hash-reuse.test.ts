/**
 * Embeddings are reused by content: a chunk whose exact text is already in the
 * table (same embedding space) takes that row's vector instead of a provider
 * call — unchanged functions in an edited file, rows under an older id scheme,
 * identical code in another repo. Drives the real buildKB + embedChunks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';
import { VectorStore, contentHash } from '../vector-store.js';
import { CHUNK_ID_VERSION } from '../chunker.js';
import { fn, withKbFixture } from './kb-fixture.js';

const names = (rows: CodeChunk[]) => rows.map((r) => r.entityName).sort();
const five = (salt3 = '') => fn('alpha') + fn('beta') + fn('gamma', salt3) + fn('delta') + fn('epsilon');

describe('embedding reuse by content hash', () => {
  it('editing one function re-embeds only that chunk, and the old version is gone', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'src/m.ts': '// header\n' + five() });
      await f.index();
      const before = f.embedded();
      // Insert a line at the top too, so every chunk below moves (new ids).
      f.write('svc', 'src/m.ts', '// header\n// moved\n' + five(' + 1'));
      f.commit('svc');
      await f.index();
      const rows = await f.rows();
      // gamma changed, and alpha's chunk carries the header comments that
      // changed; plus one probe embedding confirms the space. The rest is reused.
      assert.ok(f.embedded() - before <= 3, `re-embedded ${f.embedded() - before} chunks for a one-function edit`);
      assert.deepEqual(names(rows.filter((r) => r.entityName)), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'duplicate ids');
      const gamma = rows.filter((r) => r.entityName === 'gamma');
      assert.equal(gamma.length, 1);
      assert.ok(gamma[0].content.includes('+ 1'), 'old gamma body still indexed');
    });
  });

  it('rows under an older id scheme are reused by content, then swept', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa'), 'b.ts': fn('bbb') });
      await f.index();
      // Re-key every row as an older id scheme would have.
      const v = f.storage().vectors;
      await v.init();
      const rows = await v.getByIds(await v.getChunkIds(f.project));
      const lancedb = await import('@lancedb/lancedb');
      const table = await (await lancedb.connect(`${process.env.CODE_SEARCH_DATA_DIR}/${f.project}/lancedb`)).openTable('chunks');
      await table.update({ valuesSql: { id: "concat('legacy-', id)" } });

      const before = f.embedded();
      await f.index();
      assert.equal(f.embedded() - before, 1, 'only the space probe is embedded; unchanged text is reused');
      const after = await f.rows();
      assert.deepEqual(after.map((r) => r.id).sort(), rows.map((r) => r.id).sort(), 'current ids, legacy rows swept');
    });
  });

  it('a chunk-version bump re-chunks every repo but re-embeds no unchanged text', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa') + fn('bbb'), 'b.ts': fn('ccc') });
      await f.index();
      const blobs = f.storage().blobs;
      const meta = await blobs.getJson<Record<string, unknown>>('svc/index_meta.json');
      await blobs.putJson('svc/index_meta.json', { ...meta, chunkIdVersion: CHUNK_ID_VERSION - 1 });
      const ids = (await f.rows()).map((r) => r.id).sort();

      const before = f.embedded();
      await f.index();
      const after = await blobs.getJson<{ chunkIdVersion?: number }>('svc/index_meta.json');
      assert.equal(after?.chunkIdVersion, CHUNK_ID_VERSION, 'repo was re-chunked');
      assert.equal(f.embedded() - before, 0, 'unchanged chunks re-embedded');
      assert.deepEqual((await f.rows()).map((r) => r.id).sort(), ids);
    });
  });

  it('identical code in a newly added repo is not embedded again', async (t) => {
    await withKbFixture(t, async (f) => {
      const shared = fn('sharedOne') + fn('sharedTwo') + fn('sharedThree');
      f.repo('ra', { 'src/shared.ts': shared });
      await f.index();
      const before = f.embedded();
      f.repo('rb', { 'src/shared.ts': shared });
      await f.index();
      assert.equal(f.embedded() - before, 1, 'only the space probe is embedded');
      assert.equal((await f.rows()).filter((r) => r.entityName === 'sharedOne').length, 2, 'each repo keeps its own row');
    });
  });

  it('vectors from a different embedding model are never reused', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa'), 'b.ts': fn('bbb') });
      await f.index();
      const lancedb = await import('@lancedb/lancedb');
      const table = await (await lancedb.connect(`${process.env.CODE_SEARCH_DATA_DIR}/${f.project}/lancedb`)).openTable('chunks');
      await table.update({ valuesSql: { id: "concat('legacy-', id)" } });
      f.config.embedding.model = 'stub-v2';

      const before = f.embedded();
      await f.index();
      // One probe embedding shows the space changed; then every chunk is embedded.
      assert.ok(f.embedded() - before >= 2, `only ${f.embedded() - before} embedded after a model change`);
    });
  });
});

describe('deleteRows', () => {
  it('deletes hundreds of exact (id, contentHash) rows — Lance caps one filter at 500 conditions', async (t) => {
    try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb unavailable'); return; }
    const dir = join(tmpdir(), `del-rows-${randomBytes(5).toString('hex')}`);
    try {
      const store = new VectorStore(dir);
      await store.init();
      const rows = Array.from({ length: 700 }, (_, i) => ({
        id: `r${i}`, filePath: 'f.ts', repoName: 'r', project: 'p', startLine: i, endLine: i,
        content: `text ${i}`, contextPrefix: '', contextualizedContent: `text ${i}`, language: 'typescript',
        entityType: 'function' as const, entityName: `f${i}`, tokens: 2, imports: [], exports: [], embedding: [1, 0, 0, 0],
      }));
      await store.addChunks(rows, { skipIndex: true });
      await store.deleteRows(rows.slice(0, 650).map((r) => ({ id: r.id, contentHash: contentHash(r.contextualizedContent) })));
      assert.equal((await store.getStats())?.rowCount, 50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
