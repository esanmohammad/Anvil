/**
 * Retriever / vector-store configuration contracts: the vector-space guard
 * catches every embedding change, cached retrievers honour per-call config,
 * upsertChunks only replaces the rows it is given, and the freshness TTL env
 * means what it says.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getRetriever, retrieverFreshnessMs } from '@esankhan3/anvil-knowledge-core';
import { fn, withKbFixture } from './kb-fixture.js';

describe('retriever configuration', () => {
  it('refuses to query an index embedded with a different model or dimension', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa') });
      await f.index();
      const e = f.config.embedding;
      await assert.rejects(getRetriever(f.project, { ...f.config, embedding: { ...e, model: 'other-model' } }), /Vector-space mismatch/);
      await assert.rejects(getRetriever(f.project, { ...f.config, embedding: { ...e, dimensions: 16 } }), /Vector-space mismatch/);
      await assert.doesNotReject(getRetriever(f.project, f.config));
    });
  });

  it('honours retrieval settings that differ between calls', async (t) => {
    await withKbFixture(t, async (f) => {
      // One function per file, so the per-file result cap doesn't bound the count.
      f.repo('svc', Object.fromEntries(['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((n) => [`${n}.ts`, fn(`pick${n}`)])));
      await f.index();
      const narrow = await getRetriever(f.project, { ...f.config, retrieval: { ...f.config.retrieval, maxChunks: 2 } });
      const wide = await getRetriever(f.project, { ...f.config, retrieval: { ...f.config.retrieval, maxChunks: 6 } });
      assert.equal((await narrow.retrieve('number', { mode: 'bm25' })).chunks.length, 2);
      assert.equal((await wide.retrieve('number', { mode: 'bm25' })).chunks.length, 6);
    });
  });

  it('upsertChunks replaces only the rows it is given', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa') + fn('bbb') + fn('ccc') });
      await f.index();
      const v = f.storage().vectors;
      await v.init();
      const rows = await f.rows();
      const target = rows.find((r) => r.entityName === 'bbb')!;
      await v.upsertChunks([
        { ...target, content: 'updated body', embedding: Array(8).fill(0.2) },
        { ...target, id: 'feedfacefeedface', entityName: 'added', embedding: Array(8).fill(0.3) },
      ]);
      const after = await f.rows();
      assert.equal(after.length, 4);
      assert.equal(after.find((r) => r.id === target.id)?.content, 'updated body');
      assert.ok(after.some((r) => r.entityName === 'aaa') && after.some((r) => r.entityName === 'ccc'));
    });
  });
});

describe('retrieverFreshnessMs', () => {
  afterEach(() => { delete process.env.CODE_SEARCH_RETRIEVER_TTL_MS; });

  it('defaults to 30s, honours a value, and 0 disables the freshness check', () => {
    assert.equal(retrieverFreshnessMs(), 30_000);
    process.env.CODE_SEARCH_RETRIEVER_TTL_MS = '5000';
    assert.equal(retrieverFreshnessMs(), 5000);
    process.env.CODE_SEARCH_RETRIEVER_TTL_MS = '0';
    assert.equal(retrieverFreshnessMs(), 0);
    process.env.CODE_SEARCH_RETRIEVER_TTL_MS = 'junk';
    assert.equal(retrieverFreshnessMs(), 30_000);
  });
});

describe('getChunksByEntity', () => {
  it('resolves a class-qualified method to that class\'s chunk', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'ui.ts': 'export class Board {\n  render() { return "board"; }\n}\n\nexport class Card {\n  render() { return "card"; }\n}\n' });
      await f.index();
      const v = f.storage().vectors;
      await v.init();
      const hits = await v.getChunksByEntity([{ repoName: 'svc', filePath: 'ui.ts', entityName: 'Card.render' }]);
      assert.equal(hits.length, 1);
      assert.match(hits[0].chunk.content, /"card"/);
    });
  });
});
