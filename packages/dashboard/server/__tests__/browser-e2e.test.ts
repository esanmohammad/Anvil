/**
 * H10-followup #6 — end-to-end happy path through the browser tool
 * surface. Wires the executor, the bridge, a stub Playwright runner,
 * and a stub summarizer; round-trips:
 *
 *   browser_navigate → browser_click → browser_extract → browser_done
 *
 * Asserts the final agent-visible content + that each step records a
 * `ctx.effect()` event when a step context is registered. No real
 * network, no Playwright binary, no Docker — pure stubs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WebToolExecutor,
  withCurrentStepContext,
  type WebToolBackends,
  type ToolCall,
} from '@esankhan3/anvil-agent-core';
import type { BrowserRunner, RunnerSnapshot } from '../browser/session-manager.js';
import { createWebToolBridge } from '../tools/web-tool-bridge.js';

function snapshotFor(url: string, title: string, content: string): RunnerSnapshot {
  return {
    url,
    title,
    domRoot: {
      tag: 'body',
      children: [
        { tag: 'h1', text: title },
        { tag: 'p', text: content },
        { tag: 'a', attrs: { href: '/next' }, text: 'Next', interactive: true },
        { tag: 'button', text: 'Submit', interactive: true },
      ],
    },
    axText: '',
    scroll: { x: 0, y: 0, pageHeight: 1000, viewportHeight: 600 },
    tabs: [{ tabId: 'main', title, url, active: true }],
  };
}

function makeStubRunner(): BrowserRunner {
  let url = 'about:blank';
  return {
    async navigate({ url: u }) { url = u; return snapshotFor(url, 'Stub Page', 'Hello world.'); },
    async click() { url = url + '#clicked'; return snapshotFor(url, 'After click', 'You clicked.'); },
    async input() { return snapshotFor(url, 'Input', 'Typed.'); },
    async scroll() { return snapshotFor(url, 'Scrolled', 'Scrolled.'); },
    async snapshot() { return snapshotFor(url, 'Stub Page', 'Hello world.'); },
    async searchPage() { return { hits: [] }; },
    async screenshot() { return { imageBase64: 'AAAA', width: 1280, height: 720 }; },
    async evaluate() { return { result: null, resolved: true }; },
    async consoleMessages() { return { messages: [] }; },
    async networkRequests() { return { requests: [] }; },
    async newTab() { return snapshotFor(url, 'New', ''); },
    async closeTab() { return snapshotFor(url, 'Closed', ''); },
    async tabs() { return { tabs: [{ tabId: 'main', title: 'Stub Page', url }] }; },
    async close() { /* no-op */ },
  };
}

function makeStubInvoker() {
  return async () => '{"data": {"title": "Stub Page", "links": ["/next"]}}';
}

const ctx = { workingDir: '/tmp', abortSignal: new AbortController().signal };

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'c-' + Math.random().toString(36).slice(2, 8), name, arguments: args };
}

describe('Tier 2 e2e — navigate → click → extract → done', () => {
  it('round-trips through the bridge with stub runner + stub summarizer', async () => {
    const backends: WebToolBackends = createWebToolBridge({
      browserRunnerFactory: async () => makeStubRunner(),
      summarizerInvoker: makeStubInvoker(),
    });

    const exec = new WebToolExecutor({
      allowedTools: [
        'browser_navigate', 'browser_click', 'browser_extract', 'browser_done',
      ],
      backends,
    });

    const nav = await exec.execute(call('browser_navigate', { url: 'https://example.com' }), ctx);
    assert.equal(nav.isError, false, `navigate failed: ${nav.content}`);
    assert.match(nav.content, /https:\/\/example\.com/);
    assert.match(nav.content, /\[0\]/, 'serialized DOM should expose interactive index 0');

    const click = await exec.execute(call('browser_click', { index: 0 }), ctx);
    assert.equal(click.isError, false, `click failed: ${click.content}`);
    assert.match(click.content, /#clicked/);

    const extract = await exec.execute(call('browser_extract', { query: 'page metadata' }), ctx);
    assert.equal(extract.isError, false, `extract failed: ${extract.content}`);
    assert.match(extract.content, /"title":\s*"Stub Page"/);

    const done = await exec.execute(call('browser_done', { text: 'all good', success: true }), ctx);
    assert.equal(done.isError, false);
    assert.match(done.content, /Browser session ended/);
  });

  it('records ctx.effect events for each Tier 2 action when wrapped in withCurrentStepContext', async () => {
    const effects: Array<{ name: string }> = [];
    const stepCtx = {
      runId: 'r-e2e',
      effect: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        effects.push({ name });
        return fn();
      },
    };

    const backends: WebToolBackends = createWebToolBridge({
      browserRunnerFactory: async () => makeStubRunner(),
      summarizerInvoker: makeStubInvoker(),
    });
    const exec = new WebToolExecutor({
      allowedTools: ['browser_navigate', 'browser_click', 'browser_done'],
      backends,
    });

    await withCurrentStepContext(stepCtx, async () => {
      await exec.execute(call('browser_navigate', { url: 'https://example.com' }), ctx);
      await exec.execute(call('browser_click', { index: 0 }), ctx);
      await exec.execute(call('browser_done', { text: 'ok' }), ctx);
    });

    const navEffects = effects.filter((e) => e.name.startsWith('browser:navigate:'));
    const clickEffects = effects.filter((e) => e.name.startsWith('browser:click:'));
    assert.equal(navEffects.length, 1, `expected 1 navigate effect, got ${navEffects.length}`);
    assert.equal(clickEffects.length, 1, `expected 1 click effect, got ${clickEffects.length}`);
  });
});

describe('Tier 1 e2e — web.search end-to-end', () => {
  it('round-trips a search through the bridge with a stub provider env', async () => {
    const fakeFetch: typeof fetch = async () => new Response(
      JSON.stringify({ web: { results: [
        { title: 'Anvil', url: 'https://anvil.dev', description: 'pipeline' },
      ] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    process.env.BRAVE_SEARCH_API_KEY = 'test-key';
    try {
      const backends: WebToolBackends = createWebToolBridge({
        searchProvider: 'brave',
        fetch: fakeFetch,
      });
      const exec = new WebToolExecutor({ allowedTools: ['web_search'], backends });
      const r = await exec.execute(call('web_search', { query: 'anvil' }), ctx);
      assert.equal(r.isError, false, `search failed: ${r.content}`);
      assert.match(r.content, /Anvil/);
      assert.match(r.content, /anvil\.dev/);
    } finally {
      delete process.env.BRAVE_SEARCH_API_KEY;
    }
  });
});
