/**
 * H1 — `web.search` executor: arg validation, allow/block-list filtering,
 * backend dispatch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebToolExecutor, type WebSearchBackend } from '../web-executor.js';
import { matchDomainGlob, filterByDomainAllowList, filterByDomainBlockList } from '../domain-matcher.js';
import type { ToolCall } from '../../types.js';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'c1', name, arguments: args };
}

const ctx = { workingDir: '/tmp', abortSignal: new AbortController().signal };

class StubSearchBackend implements WebSearchBackend {
  public last: { query: string; allowedDomains?: string[]; blockedDomains?: string[]; limit?: number } | undefined;
  constructor(private readonly results: Array<{ title: string; url: string; snippet?: string }>) {}
  async search(args: { query: string; allowedDomains?: string[]; blockedDomains?: string[]; limit?: number }) {
    this.last = args;
    let results = this.results.slice();
    results = filterByDomainAllowList(results, args.allowedDomains);
    results = filterByDomainBlockList(results, args.blockedDomains);
    if (args.limit) results = results.slice(0, args.limit);
    return { query: args.query, results, resultCount: results.length };
  }
}

describe('matchDomainGlob', () => {
  it('exact host match', () => {
    assert.equal(matchDomainGlob('https://example.com/x', 'example.com'), true);
    assert.equal(matchDomainGlob('https://other.com/x', 'example.com'), false);
  });

  it('leftmost subdomain wildcard', () => {
    assert.equal(matchDomainGlob('https://docs.example.com/x', '*.example.com'), true);
    assert.equal(matchDomainGlob('https://example.com/x', '*.example.com'), false, 'apex does not match leftmost');
    assert.equal(matchDomainGlob('https://a.b.example.com/x', '*.example.com'), false, 'two-level does not match');
  });

  it('any-subdomain wildcard `**.example.com`', () => {
    assert.equal(matchDomainGlob('https://example.com/x', '**.example.com'), true);
    assert.equal(matchDomainGlob('https://docs.example.com/x', '**.example.com'), true);
    assert.equal(matchDomainGlob('https://a.b.example.com/x', '**.example.com'), true);
  });

  it('host + path prefix', () => {
    assert.equal(matchDomainGlob('https://github.com/anvil/x', 'github.com/*'), true);
    assert.equal(matchDomainGlob('https://github.com/anvil/x', 'github.com/anvil/*'), true);
    assert.equal(matchDomainGlob('https://github.com/other/x', 'github.com/anvil/*'), false);
  });

  it('rejects unparseable URLs', () => {
    assert.equal(matchDomainGlob('not-a-url', 'example.com'), false);
  });
});

describe('WebToolExecutor — schema gating', () => {
  it('listSchemas returns only allowed names', () => {
    const exec = new WebToolExecutor({ allowedTools: ['web_search'], backends: { search: new StubSearchBackend([]) } });
    const names = exec.listSchemas().map((s) => s.name);
    assert.deepEqual(names, ['web_search']);
  });

  it('listSchemas hides web_search when not allowed', () => {
    const exec = new WebToolExecutor({ allowedTools: ['read_file'], backends: { search: new StubSearchBackend([]) } });
    assert.deepEqual(exec.listSchemas(), []);
  });
});

describe('WebToolExecutor — web_search execution', () => {
  it('rejects calls when the backend is missing', async () => {
    const exec = new WebToolExecutor({ allowedTools: ['web_search'] });
    const r = await exec.execute(call('web_search', { query: 'hello' }), ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /backend not configured/);
  });

  it('rejects too-short queries', async () => {
    const exec = new WebToolExecutor({
      allowedTools: ['web_search'],
      backends: { search: new StubSearchBackend([]) },
    });
    const r = await exec.execute(call('web_search', { query: 'a' }), ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /at least 2 characters/);
  });

  it('forwards allowedDomains + blockedDomains to the backend', async () => {
    const backend = new StubSearchBackend([
      { title: 'Anvil docs', url: 'https://docs.anvil.dev/x', snippet: 's' },
      { title: 'Spam', url: 'https://spam.example.com/x' },
    ]);
    const exec = new WebToolExecutor({ allowedTools: ['web_search'], backends: { search: backend } });
    const r = await exec.execute(
      call('web_search', {
        query: 'anvil docs',
        allowedDomains: ['*.anvil.dev'],
        blockedDomains: ['spam.example.com'],
        limit: 5,
      }),
      ctx,
    );
    assert.equal(r.isError, false);
    assert.equal(backend.last?.query, 'anvil docs');
    assert.deepEqual(backend.last?.allowedDomains, ['*.anvil.dev']);
    assert.deepEqual(backend.last?.blockedDomains, ['spam.example.com']);
    assert.match(r.content, /Anvil docs/);
    assert.equal(/Spam/.test(r.content), false, 'spam domain should be filtered out');
  });

  it('formats empty results gracefully', async () => {
    const backend = new StubSearchBackend([]);
    const exec = new WebToolExecutor({ allowedTools: ['web_search'], backends: { search: backend } });
    const r = await exec.execute(call('web_search', { query: 'no hits' }), ctx);
    assert.equal(r.isError, false);
    assert.match(r.content, /no matches/);
  });

  it('rejects an out-of-range limit', async () => {
    const exec = new WebToolExecutor({
      allowedTools: ['web_search'],
      backends: { search: new StubSearchBackend([]) },
    });
    const r = await exec.execute(call('web_search', { query: 'qq', limit: 100 }), ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /\[1, 25\]/);
  });

  it('rejects calls for tools not in the allow set', async () => {
    const exec = new WebToolExecutor({ allowedTools: ['web_search'] });
    const r = await exec.execute(call('web_fetch', { url: 'https://x', prompt: 'q' }), ctx);
    assert.equal(r.isError, true);
    assert.match(r.content, /not permitted/);
  });
});
