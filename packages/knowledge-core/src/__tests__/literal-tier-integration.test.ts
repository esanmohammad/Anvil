/**
 * Literal tier v2 against a REAL LanceDB table — pins the actual ILIKE scan
 * (substring semantics, ranking, wildcard escaping) and tantivy PhraseQuery
 * (positions-backed adjacency) rather than stubs.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { VectorStore } from '../vector-store.js';
import type { CodeChunk } from '../types.js';

const base = join(tmpdir(), `literal-tier-${randomBytes(5).toString('hex')}`);

function chunk(id: string, entityName: string, content: string): CodeChunk & { embedding: number[] } {
  return {
    id, filePath: `${id}.ts`, repoName: 'r', project: 'p', startLine: 1, endLine: 3,
    content, contextPrefix: '', contextualizedContent: content, language: 'typescript',
    entityType: 'function', entityName, tokens: 10, imports: [], exports: [],
    embedding: [1, 0, 0, 0],
  };
}

describe('literal tier v2 — real LanceDB', () => {
  const store = new VectorStore(join(base, 'lancedb'));

  before(async () => {
    try { await import('@lancedb/lancedb'); } catch { return; }
    await store.init();
    await store.upsertChunks([
      chunk('a', 'CompanySearchResponse', 'export function CompanySearchResponse(){ return searchCompanies(); }'),
      chunk('b', 'SearchResponse', 'export class SearchResponse { body: string; }'),
      chunk('c', 'UserSearchResponseMapper', 'export function UserSearchResponseMapper(){}'),
      chunk('d', 'MAX_RETRY_COUNT', 'export const MAX_RETRY_COUNT = 5; // failed to render template here'),
      chunk('e', 'unrelatedThing', 'function unrelatedThing(){ /* template render failed differently */ }'),
    ]);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  it('substring tier: partial identifier finds containing symbols, exact-first', async (t) => {
    try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb unavailable'); return; }
    const hits = await store.searchByEntitySubstring('SearchResponse', 10);
    const names = hits.map((h) => h.chunk.entityName);
    assert.ok(names.includes('CompanySearchResponse'), 'infix match found');
    assert.equal(names[0], 'SearchResponse', 'exact match ranks first');
    assert.ok(hits.every((h) => h.source === 'exact'));
  });

  it('substring tier: underscores match literally (LIKE wildcard escaped)', async (t) => {
    try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb unavailable'); return; }
    const hits = await store.searchByEntitySubstring('MAX_RETRY', 10);
    assert.equal(hits.length, 1, 'only the literal underscore name matches');
    assert.equal(hits[0].chunk.entityName, 'MAX_RETRY_COUNT');
  });

  it('phrase tier: adjacent tokens match, shuffled tokens do not', async (t) => {
    try { await import('@lancedb/lancedb'); } catch { t.skip('lancedb unavailable'); return; }
    await store.ensureFtsIndex(); // built withPosition — required for phrases
    const phrase = await store.phraseSearch('failed to render template', 10);
    assert.equal(phrase.length, 1, 'exact phrase matches only the adjacent occurrence');
    assert.equal(phrase[0].chunk.id, 'd');
    assert.equal(phrase[0].source, 'phrase');
    const shuffled = await store.phraseSearch('template failed render to', 10);
    assert.equal(shuffled.length, 0, 'non-adjacent word salad does not match');
  });
});
