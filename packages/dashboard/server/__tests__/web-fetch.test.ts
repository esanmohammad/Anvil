/**
 * H2 — `web.fetch` end-to-end against a stub HTTP fetcher + a
 * deterministic summarizer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { WebFetchAdapter } from '../tools/web-fetch.js';
import { htmlToMarkdown, looksLikeSpaShell } from '../tools/html-to-markdown.js';

function fakeResponse(body: string, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(opts.headers ?? { 'content-type': 'text/html; charset=utf-8' });
  return new Response(body, { status: opts.status ?? 200, headers });
}

function fakeRedirect(location: string, status = 302): Response {
  return new Response('', { status, headers: { Location: location } });
}

const stubInvoker = async () => 'paraphrased answer (≤500 words)';
const ctx = { workingDir: '/tmp', abortSignal: new AbortController().signal };
void ctx;

describe('htmlToMarkdown', () => {
  it('strips <script> blocks completely', () => {
    const md = htmlToMarkdown('<p>hi</p><script>alert(1)</script><p>bye</p>');
    assert.equal(md.includes('alert'), false);
    assert.match(md, /hi/);
    assert.match(md, /bye/);
  });

  it('removes inline event handlers', () => {
    const md = htmlToMarkdown('<a href="x" onclick="evil()">link</a>');
    assert.match(md, /\[link\]\(x\)/);
    assert.equal(md.includes('evil'), false);
  });

  it('converts headings + lists', () => {
    const html = '<h2>Title</h2><ul><li>one</li><li>two</li></ul>';
    const md = htmlToMarkdown(html);
    assert.match(md, /## Title/);
    assert.match(md, /- one/);
    assert.match(md, /- two/);
  });

  it('decodes HTML entities', () => {
    const md = htmlToMarkdown('<p>A &amp; B &#8212; ok</p>');
    assert.match(md, /A & B/);
  });
});

describe('looksLikeSpaShell', () => {
  it('classifies tiny markdown as SPA', () => {
    assert.equal(looksLikeSpaShell(''), true);
    assert.equal(looksLikeSpaShell('   '), true);
  });
  it('classifies real content as SSR', () => {
    const big = 'lorem '.repeat(200);
    assert.equal(looksLikeSpaShell(big), false);
  });
});

describe('WebFetchAdapter', () => {
  it('fetches, converts, and summarizes', async () => {
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => fakeResponse('<h1>Hello</h1><p>' + 'content '.repeat(60) + '</p>'),
    });
    const r = await adapter.fetch({ url: 'https://example.com/x', prompt: 'what is the title?' });
    assert.equal(r.ssr, true);
    assert.equal(r.url, 'https://example.com/x');
    assert.match(r.answer, /paraphrased answer/);
  });

  it('returns SPA marker when body is empty', async () => {
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => fakeResponse('<html><body><div id="root"></div></body></html>'),
    });
    const r = await adapter.fetch({ url: 'https://spa.example.com/x', prompt: 'what?' });
    assert.equal(r.ssr, false);
    assert.match(r.hint ?? '', /SPA/);
  });

  it('caches identical (url, prompt) calls', async () => {
    let count = 0;
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => { count += 1; return fakeResponse('<p>' + 'x'.repeat(500) + '</p>'); },
    });
    await adapter.fetch({ url: 'https://example.com/y', prompt: 'q' });
    await adapter.fetch({ url: 'https://example.com/y', prompt: 'q' });
    assert.equal(count, 1, 'second call should hit cache');
  });

  it('follows same-host redirects', async () => {
    let step = 0;
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => {
        step += 1;
        if (step === 1) return fakeRedirect('https://example.com/final');
        return fakeResponse('<p>' + 'x'.repeat(500) + '</p>');
      },
    });
    const r = await adapter.fetch({ url: 'https://example.com/initial', prompt: 'q' });
    assert.equal(r.finalUrl, 'https://example.com/final');
  });

  it('blocks cross-host redirects', async () => {
    let step = 0;
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => {
        step += 1;
        if (step === 1) return fakeRedirect('https://attacker.example.com/x');
        return fakeResponse('<p>x</p>');
      },
    });
    await assert.rejects(
      () => adapter.fetch({ url: 'https://docs.example.com/x', prompt: 'q' }),
      /cross-host redirect/,
    );
  });

  it('honors blockedDomains', async () => {
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => fakeResponse('<p>x</p>'),
      blockedDomains: ['evil.com'],
    });
    await assert.rejects(
      () => adapter.fetch({ url: 'https://evil.com/x', prompt: 'q' }),
      /deny-list/,
    );
  });

  it('honors allowedDomains', async () => {
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async () => fakeResponse('<p>x</p>'),
      allowedDomains: ['*.docs.example.com'],
    });
    await assert.rejects(
      () => adapter.fetch({ url: 'https://other.com/x', prompt: 'q' }),
      /not on the project allow-list/,
    );
  });

  it('upgrades http://→https://', async () => {
    const seen: string[] = [];
    const adapter = new WebFetchAdapter({
      invokeSummarizer: stubInvoker,
      summarizerModelOverride: 'test-model',
      fetch: async (input: string | URL | Request) => {
        const u = typeof input === 'string' ? input : input.toString();
        seen.push(u);
        return fakeResponse('<p>' + 'x'.repeat(500) + '</p>');
      },
    });
    await adapter.fetch({ url: 'http://example.com/x', prompt: 'q' });
    assert.match(seen[0], /^https:\/\//);
  });
});
