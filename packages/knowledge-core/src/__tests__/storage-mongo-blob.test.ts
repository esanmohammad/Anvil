/**
 * P2a — MongoBlobStore real-MongoDB contract round-trip.
 *
 * Exercises the full BlobStorePort contract against a live MongoDB (collection
 * docs for JSON/text, GridFS for bytes + NDJSON), plus config-driven selection
 * via resolveStorage(blob.backend='mongo'). Skips cleanly when the driver is
 * absent or no server is reachable (set MONGO_TEST_URI to point elsewhere); a
 * throwaway db is created and dropped so it leaves nothing behind.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { MongoBlobStore, resolveStorage, closeMongoClients } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig } from '@esankhan3/anvil-knowledge-core';

const BASE_URI = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017';
const URI = BASE_URI + (BASE_URI.includes('?') ? '&' : '/?') + 'serverSelectionTimeoutMS=2000';

describe('MongoBlobStore — real MongoDB contract round-trip (P2a)', () => {
  it('round-trips json/text/bytes/ndjson + list/delete/deletePrefix, incl. via resolveStorage', async (t) => {
    try { await import('mongodb'); } catch { t.skip('mongodb driver unavailable'); return; }

    const db = `kc_mongo_test_${randomBytes(5).toString('hex')}`;
    const project = 'p';
    const store = new MongoBlobStore(project, { uri: URI, db });

    // Preflight — skip the whole test if no server answers within the timeout.
    try {
      await store.exists('__preflight__');
    } catch {
      await closeMongoClients();
      t.skip(`no MongoDB server reachable at ${BASE_URI}`);
      return;
    }

    const tmp = mkdtempSync(join(tmpdir(), 'kc-mongo-'));
    try {
      // JSON
      await store.putJson('repoA/index_meta.json', { lastIndexedSha: 'abc', n: 3 });
      assert.deepEqual(await store.getJson('repoA/index_meta.json'), { lastIndexedSha: 'abc', n: 3 });
      assert.equal(await store.getJson('missing.json'), null);

      // text + exists
      assert.equal(await store.exists('PROJECT_SUMMARY.md'), false);
      await store.putText('PROJECT_SUMMARY.md', '# hi\n');
      assert.equal(await store.exists('PROJECT_SUMMARY.md'), true);
      assert.equal(await store.getText('PROJECT_SUMMARY.md'), '# hi\n');

      // bytes: buffer round-trip, toFile materialization, putBytes(local path)
      const payload = randomBytes(4096);
      await store.putBytes('system_graph.sqlite', payload);
      assert.ok(((await store.getBytes('system_graph.sqlite')) as Buffer).equals(payload));
      const dest = join(tmp, 'pulled.sqlite');
      assert.equal(await store.getBytes('system_graph.sqlite', { toFile: dest }), dest);
      assert.ok(readFileSync(dest).equals(payload));
      const src = join(tmp, 'src.bin');
      const p2 = randomBytes(1024);
      writeFileSync(src, p2);
      await store.putBytes('graph/copy.sqlite', src);
      assert.ok(((await store.getBytes('graph/copy.sqlite')) as Buffer).equals(p2));
      assert.equal(await store.getBytes('nope.sqlite'), null);

      // NDJSON: write + stream back, overwrite shrinks, missing yields nothing
      const recs = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, v: i }));
      await store.putNdjson('chunks.json', recs);
      const got: Array<{ id: string; v: number }> = [];
      for await (const r of store.iterateNdjson<{ id: string; v: number }>('chunks.json')) got.push(r);
      assert.deepEqual(got, recs);
      await store.putNdjson('chunks.json', recs.slice(0, 3));
      const got2: unknown[] = [];
      for await (const r of store.iterateNdjson('chunks.json')) got2.push(r);
      assert.equal(got2.length, 3);
      const none: unknown[] = [];
      for await (const r of store.iterateNdjson('missing.json')) none.push(r);
      assert.equal(none.length, 0);

      // list across both stores; prefix + root
      const all = await store.list('');
      for (const k of ['repoA/index_meta.json', 'PROJECT_SUMMARY.md', 'system_graph.sqlite', 'chunks.json']) {
        assert.ok(all.includes(k), `list('') should include ${k}`);
      }
      assert.deepEqual((await store.list('repoA')).sort(), ['repoA/index_meta.json']);

      // delete + deletePrefix (both stores)
      await store.delete('PROJECT_SUMMARY.md');
      assert.equal(await store.exists('PROJECT_SUMMARY.md'), false);
      await store.putJson('repoA/profile.json', { name: 'A' });
      await store.deletePrefix('repoA');
      assert.equal(await store.exists('repoA/index_meta.json'), false);
      assert.equal(await store.exists('repoA/profile.json'), false);

      // config-driven selection: resolveStorage(blob.backend='mongo') → MongoBlobStore
      const bundle = resolveStorage(project, {
        embedding: { provider: 'openai' },
        chunking: { maxTokens: 500, contextEnrichment: 'structural' },
        retrieval: { maxChunks: 8, maxTokens: 12000, hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 }, reranker: 'none' },
        autoIndex: true,
        storage: { blob: { backend: 'mongo', mongo: { uri: URI, db } } },
      } as KnowledgeConfig);
      await bundle.blobs.putText('via-bundle.md', 'ok');
      assert.equal(await bundle.blobs.getText('via-bundle.md'), 'ok');
    } finally {
      try {
        const mongodb = await import('mongodb');
        const c = new mongodb.MongoClient(URI);
        await c.connect();
        await c.db(db).dropDatabase();
        await c.close();
      } catch { /* best-effort cleanup */ }
      await closeMongoClients();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
