/**
 * BM25 must match words that only occur fused inside camelCase identifiers
 * (`verifyExpectedBacklogCount` for "expected backlog count"), keep exact-token
 * matching, and keep working on tables written before the split column existed.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VectorStore, splitIdentifiers, identifierParts } from '../vector-store.js';
import type { CodeChunk } from '../types.js';

const base = join(tmpdir(), `ident-bm25-${randomBytes(5).toString('hex')}`);
after(() => rmSync(base, { recursive: true, force: true }));

function chunk(id: string, content: string): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: `${id}.ts`, repoName: 'r', project: 'p', startLine: 1, endLine: 3,
    content, contextPrefix: '', contextualizedContent: content, language: 'typescript',
    entityType: 'function', entityName: id, tokens: 10, imports: [], exports: [],
    embedding: [1, 0, 0, 0],
  };
}

const FUSED = 'export function verifyExpectedBacklogCount(q) { return parseHTTPResponse2Json(q); }';
const PROSE = 'function noop() { /* nothing to see here */ }';

async function lanceAvailable(t: { skip: (msg: string) => void }): Promise<boolean> {
  try { await import('@lancedb/lancedb'); return true; } catch { t.skip('lancedb unavailable'); return false; }
}

const ids = (hits: Array<{ chunk: CodeChunk }>) => hits.map((h) => h.chunk.id);

describe('splitIdentifiers', () => {
  it('splits camelCase, PascalCase, acronyms and digit→upper boundaries; leaves the rest', () => {
    assert.equal(splitIdentifiers('verifyExpectedBacklogCount'), 'verify Expected Backlog Count');
    assert.equal(splitIdentifiers('XMLHttpRequest'), 'XML Http Request');
    assert.equal(splitIdentifiers('parseHTTPResponse2Json'), 'parse HTTP Response2 Json');
    assert.equal(splitIdentifiers('snake_case MAX_RETRY plain words'), 'snake_case MAX_RETRY plain words');
  });

  it('identifierParts keeps only the parts of compound identifiers', () => {
    const words = (s: string) => s.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    assert.deepEqual(words(identifierParts(FUSED)), ['verify', 'Expected', 'Backlog', 'Count', 'parse', 'HTTP', 'Response2', 'Json']);
    assert.deepEqual(words(identifierParts('const MAX_RETRY = 5; class User extends BaseModel {}')), ['Base', 'Model']);
  });
});

describe('identifier-aware BM25', () => {
  it('words fused in an identifier match; exact identifiers still rank first', async (t) => {
    if (!(await lanceAvailable(t))) return;
    const store = new VectorStore(join(base, 'fresh'));
    await store.init();
    await store.addChunks([chunk('fused', FUSED), chunk('prose', PROSE), chunk('other', 'const expected = 1; // backlog')], { skipIndex: true });
    await store.ensureFtsIndex();
    assert.ok(ids(await store.fullTextSearch('expected backlog count', 10)).includes('fused'), 'fused words found');
    assert.equal(ids(await store.fullTextSearch('http response', 10))[0], 'fused');
    assert.equal(ids(await store.fullTextSearch('BacklogCount', 10))[0], 'fused', 'partial compound identifier');
    assert.equal(ids(await store.fullTextSearch('verifyExpectedBacklogCount', 10))[0], 'fused');
    assert.deepEqual(ids(await store.fullTextSearch('expected backlog count', 10, "id = 'prose'")), [], 'filter still applies');
  });

  it("a single identifier matches a row by its parts only when all of them occur", async (t) => {
    if (!(await lanceAvailable(t))) return;
    const store = new VectorStore(join(base, 'parts'));
    await store.init();
    await store.addChunks([
      chunk('exact', 'const u = getUserById(id);'),
      chunk('longer', 'return getUserByIdOrThrow(id);'),
      chunk('some', 'const c = getConfig(); lookupById(c);'),
    ], { skipIndex: true });
    await store.ensureFtsIndex();
    const hits = ids(await store.fullTextSearch('getUserById', 10));
    assert.equal(hits[0], 'exact');
    assert.ok(hits.includes('longer'), 'an identifier containing the query is found by its parts');
    assert.ok(!hits.includes('some'), 'a row sharing only some of the parts is not a match');
  });

  it('a snake_case constant query is not outranked by camelCase spellings of its words', async (t) => {
    if (!(await lanceAvailable(t))) return;
    const store = new VectorStore(join(base, 'snake'));
    await store.init();
    await store.addChunks([
      chunk('def', 'export const TRIGGER_TO_WEB_TYPE = { exit: "exit", scroll: "scroll" };'),
      chunk('use', 'const t = triggerToWebType(x); setTriggerToWebType(t); return isTriggerToWebType(t);'),
    ], { skipIndex: true });
    await store.ensureFtsIndex();
    assert.equal(ids(await store.fullTextSearch('TRIGGER_TO_WEB_TYPE', 10))[0], 'def');
  });

  it('a table written before the split column existed is migrated on the next write', async (t) => {
    if (!(await lanceAvailable(t))) return;
    const lancedb = await import('@lancedb/lancedb');
    const dir = join(base, 'legacy');
    // An older writer's rows: no contentSplit column.
    const { contentSplit: _drop, ...legacyRow } = rowOf(chunk('old', FUSED));
    await (await lancedb.connect(dir)).createTable('chunks', [legacyRow]);

    const reader = new VectorStore(dir);
    await reader.init();
    assert.deepEqual(ids(await reader.fullTextSearch('verifyExpectedBacklogCount', 10)), ['old'], 'old table: original column only');

    const store = new VectorStore(dir);
    await store.init();
    await store.addChunks([chunk('new', 'function fetchUserProfile() {}')], { skipIndex: true });
    await store.ensureFtsIndex();
    const table = await (await lancedb.connect(dir)).openTable('chunks');
    const old = (await table.query().where("id = 'old'").select(['contentSplit']).toArray())[0];
    assert.equal(old.contentSplit, identifierParts(FUSED), 'SQL backfill matches identifierParts');
    assert.equal(ids(await store.fullTextSearch('expected backlog count', 10))[0], 'old');
    assert.equal(ids(await store.fullTextSearch('user profile', 10))[0], 'new');
  });
});

/** The row shape addChunks writes (mirrors VectorStore's mapping). */
function rowOf(c: CodeChunk & { embedding: number[] }) {
  return {
    id: c.id, vector: c.embedding, content: c.content, contextualizedContent: c.contextualizedContent,
    contentSplit: identifierParts(c.contextualizedContent),
    contextPrefix: c.contextPrefix, filePath: c.filePath, repoName: c.repoName, project: c.project,
    entityType: c.entityType, entityName: c.entityName ?? '', parentEntity: c.parentEntity ?? '',
    language: c.language, startLine: c.startLine, endLine: c.endLine, tokens: c.tokens,
  };
}
