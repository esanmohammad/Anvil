/**
 * SearxNG provider — fifth `web.search` backend (free, self-hostable).
 * Verifies auto-detection ordering, JSON parsing, optional bearer
 * token, and the missing-base-URL error path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebSearchAdapter } from '../tools/web-search.js';

function fakeJson(body: unknown, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: opts.headers ?? { 'content-type': 'application/json' },
  });
}

const SEARXNG_RESULTS = {
  results: [
    { title: 'Anvil docs', url: 'https://anvil.dev/docs', content: 'documentation snippet' },
    { title: 'GitHub', url: 'https://github.com/esanmohammad/Anvil', content: 'repo' },
  ],
};

describe('WebSearchAdapter — SearxNG', () => {
  it('dispatches to SearxNG when SEARXNG_BASE_URL is the only env set', async () => {
    let calledUrl = '';
    const adapter = new WebSearchAdapter({
      envOverride: { SEARXNG_BASE_URL: 'https://searx.example.com' },
      fetch: async (input) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        return fakeJson(SEARXNG_RESULTS);
      },
    });
    const r = await adapter.search({ query: 'anvil' });
    assert.match(calledUrl, /^https:\/\/searx\.example\.com\/search\?/);
    assert.match(calledUrl, /q=anvil/);
    assert.match(calledUrl, /format=json/);
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].title, 'Anvil docs');
    assert.equal(r.results[0].url, 'https://anvil.dev/docs');
    assert.equal(r.results[0].snippet, 'documentation snippet');
  });

  it('strips trailing slashes on the base URL', async () => {
    let calledUrl = '';
    const adapter = new WebSearchAdapter({
      envOverride: { SEARXNG_BASE_URL: 'https://searx.example.com/////' },
      fetch: async (input) => {
        calledUrl = typeof input === 'string' ? input : input.toString();
        return fakeJson(SEARXNG_RESULTS);
      },
    });
    await adapter.search({ query: 'q' });
    assert.match(calledUrl, /^https:\/\/searx\.example\.com\/search\?/);
  });

  it('forwards Authorization: Bearer <key> when SEARXNG_API_KEY is set', async () => {
    let seenAuth: string | null = null;
    const adapter = new WebSearchAdapter({
      envOverride: {
        SEARXNG_BASE_URL: 'https://searx.example.com',
        SEARXNG_API_KEY: 'sxk-abc',
      },
      fetch: async (_input, init) => {
        seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
        return fakeJson(SEARXNG_RESULTS);
      },
    });
    await adapter.search({ query: 'q' });
    assert.equal(seenAuth, 'Bearer sxk-abc');
  });

  it('omits Authorization header when no API key is present', async () => {
    let seenAuth: string | undefined;
    const adapter = new WebSearchAdapter({
      envOverride: { SEARXNG_BASE_URL: 'https://searx.example.com' },
      fetch: async (_input, init) => {
        seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return fakeJson(SEARXNG_RESULTS);
      },
    });
    await adapter.search({ query: 'q' });
    assert.equal(seenAuth, undefined);
  });

  it('rejects when provider="searxng" is pinned but base URL missing', () => {
    assert.throws(
      () => new WebSearchAdapter({ provider: 'searxng', envOverride: {} }),
      /SEARXNG_BASE_URL not set/,
    );
  });

  it('honors auto-detect ordering — Brave wins over SearxNG when both set', async () => {
    const adapter = new WebSearchAdapter({
      envOverride: {
        BRAVE_SEARCH_API_KEY: 'brave-key',
        SEARXNG_BASE_URL: 'https://searx.example.com',
      },
      fetch: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('search.brave.com')) {
          return fakeJson({ web: { results: [{ title: 'Brave', url: 'https://x', description: 's' }] } });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    });
    const r = await adapter.search({ query: 'q' });
    assert.equal(r.results[0].title, 'Brave');
  });

  it('surfaces a clear error when SearxNG returns non-JSON', async () => {
    const adapter = new WebSearchAdapter({
      envOverride: { SEARXNG_BASE_URL: 'https://searx.example.com' },
      fetch: async () => new Response('<html>old searxng instance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    });
    await assert.rejects(
      () => adapter.search({ query: 'q' }),
      /Enable JSON output/,
    );
  });

  it('drops malformed result entries', async () => {
    const adapter = new WebSearchAdapter({
      envOverride: { SEARXNG_BASE_URL: 'https://searx.example.com' },
      fetch: async () => fakeJson({
        results: [
          { title: 'ok', url: 'https://x', content: 's' },
          { title: 'no-url' },
          { url: 'https://y' },
          { title: 'ok2', url: 'https://z' },
        ],
      }),
    });
    const r = await adapter.search({ query: 'q' });
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].title, 'ok');
    assert.equal(r.results[1].title, 'ok2');
  });
});
