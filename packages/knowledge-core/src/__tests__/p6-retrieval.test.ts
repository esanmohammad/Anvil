import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  expandQuery,
  fuseRrf,
  type LlmClient,
  tokenizerFor,
  genericTokenize,
  RerankCache,
} from '@esankhan3/anvil-knowledge-core';
import { classifyQuery } from '@esankhan3/anvil-knowledge-core';

/**
 * P6 — building-block tests for query expansion, per-language BM25
 * tokenizers, and the on-disk rerank cache. The retriever wiring is
 * opt-in; these tests pin the surface so the wiring stays simple.
 */

class StubLlm implements LlmClient {
  constructor(private response: string) {}
  async oneShot(): Promise<string> { return this.response; }
}

class ThrowingLlm implements LlmClient {
  async oneShot(): Promise<string> { throw new Error('llm offline'); }
}

describe('expandQuery (HyDE-lite)', () => {
  it('returns original alone for identifier-typed queries (skip rule)', async () => {
    const llm = new StubLlm('var x = 1;\n\nfunction y() {}');
    const cls = classifyQuery('parseRequest');
    assert.equal(cls.type, 'identifier');
    const exp = await expandQuery('parseRequest', cls, llm);
    assert.deepEqual(exp.queries, ['parseRequest']);
  });

  it('expands natural-language queries with the original first', async () => {
    const llm = new StubLlm('function handle(req) {}\n\nreturn 401;');
    const cls = classifyQuery('how does the request middleware reject expired tokens');
    const exp = await expandQuery('how does the request middleware reject expired tokens', cls, llm, { maxVariants: 2 });
    assert.equal(exp.queries.length, 3);
    assert.equal(exp.queries[0], 'how does the request middleware reject expired tokens');
    assert.equal(exp.weights[0], 1.0);
    assert.ok(exp.weights[1] < 1.0, 'variants should be down-weighted');
  });

  it('falls back to original when the LLM errors', async () => {
    const cls = classifyQuery('how does auth work end to end');
    const exp = await expandQuery('how does auth work end to end', cls, new ThrowingLlm());
    assert.equal(exp.queries.length, 1);
  });

  it('forceExpand bypasses the type-based skip rule', async () => {
    const cls = classifyQuery('parseRequest');
    const llm = new StubLlm('function parseRequest() { return req.json(); }');
    const exp = await expandQuery('parseRequest', cls, llm, { forceExpand: true, maxVariants: 1 });
    assert.equal(exp.queries.length, 2);
  });
});

describe('fuseRrf', () => {
  it('reciprocal-rank-fuses lists with weights', () => {
    const fused = fuseRrf(
      [
        ['a', 'b', 'c'],
        ['b', 'c', 'a'],
      ],
      [1.0, 0.7],
    );
    assert.deepEqual(new Set(fused), new Set(['a', 'b', 'c']));
    // 'b' appears at rank 1 (weight 1.0) and rank 0 (weight 0.7) — highest fused score.
    assert.equal(fused[0], 'b');
  });
});

describe('tokenizerFor', () => {
  it('falls back to generic for unknown languages', () => {
    const t = tokenizerFor('cobol');
    assert.deepEqual(t('foo bar'), genericTokenize('foo bar'));
  });

  it('Go tokenizer captures receiver types', () => {
    const t = tokenizerFor('go');
    const tokens = t('func (u *UserService) ParseRequest(r *http.Request) error');
    assert.ok(tokens.includes('userservice'), 'receiver type captured');
    assert.ok(tokens.includes('parserequest'));
  });

  it('Rust tokenizer captures lifetimes and :: paths', () => {
    const t = tokenizerFor('rust');
    const tokens = t("fn handle<'a>(x: &'static str, p: std::sync::Arc<T>) {}");
    assert.ok(tokens.some((tok) => tok === "'static" || tok === "'a"));
    assert.ok(tokens.includes('arc'));
  });

  it('Python tokenizer keeps dunders intact', () => {
    const t = tokenizerFor('python');
    const tokens = t('def __init__(self, x): self.x = x');
    assert.ok(tokens.includes('__init__'));
  });
});

describe('RerankCache (on-disk)', () => {
  let dir: string;
  let cache: RerankCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rerank-cache-'));
    cache = new RerankCache({ filePath: join(dir, 'cache.json'), maxEntries: 5 });
  });

  afterEach(() => {
    cache.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips entries', () => {
    cache.set('q', 'chunk-1', 'm', 0.9);
    assert.equal(cache.get('q', 'chunk-1', 'm'), 0.9);
    assert.equal(cache.get('q', 'chunk-1', 'other'), null);
  });

  it('LRU-evicts when maxEntries exceeded', () => {
    for (let i = 0; i < 10; i++) cache.set(`q${i}`, 'c', 'm', i / 10);
    assert.ok(cache.size() <= 5);
    // Earliest insertions are gone.
    assert.equal(cache.get('q0', 'c', 'm'), null);
    assert.equal(cache.get('q9', 'c', 'm'), 0.9);
  });

  it('persists across instances via flush', () => {
    cache.set('q', 'chunk-1', 'm', 0.42);
    cache.flush();
    const cache2 = new RerankCache({ filePath: join(dir, 'cache.json') });
    assert.equal(cache2.get('q', 'chunk-1', 'm'), 0.42);
  });
});
