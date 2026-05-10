/**
 * H4 — BrowserSession + BrowserSessionRegistry: lifecycle, expiry,
 * runner factory injection. Uses a stub runner so no Playwright
 * binary is required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserSession,
  BrowserSessionRegistry,
  type BrowserRunner,
  type RunnerSnapshot,
} from '../browser/session-manager.js';

function fakeSnapshot(url: string, title: string): RunnerSnapshot {
  return {
    url,
    title,
    domRoot: {
      tag: 'div',
      children: [
        { tag: 'button', text: 'Click', interactive: true },
        { tag: 'a', attrs: { href: '/x' }, text: 'Link', interactive: true },
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
    async navigate({ url: u }) { url = u; return fakeSnapshot(url, 'Stub'); },
    async click() { return fakeSnapshot(url, 'Clicked'); },
    async input() { return fakeSnapshot(url, 'Input'); },
    async scroll() { return fakeSnapshot(url, 'Scrolled'); },
    async snapshot() { return fakeSnapshot(url, 'Stub'); },
    async searchPage() { return { hits: [] }; },
    async screenshot() { return { imageBase64: 'AAAA', width: 1280, height: 720 }; },
    async evaluate() { return { result: 0, resolved: true }; },
    async consoleMessages() { return { messages: [] }; },
    async networkRequests() { return { requests: [] }; },
    async newTab() { return fakeSnapshot(url, 'NewTab'); },
    async closeTab() { return fakeSnapshot(url, 'Closed'); },
    async tabs() { return { tabs: [{ tabId: 'main', title: 'Stub', url }] }; },
    async close() { /* no-op */ },
  };
}

describe('BrowserSession', () => {
  it('lazy-inits the runner on first action', async () => {
    let inited = 0;
    const session = new BrowserSession(async () => { inited += 1; return makeStubRunner(); }, {
      runId: 'r1', sessionId: 's1', userDataDir: '/tmp',
    });
    assert.equal(inited, 0);
    const state = await session.navigate({ url: 'https://example.com' });
    assert.equal(inited, 1);
    assert.equal(state.url, 'https://example.com');
    assert.match(state.domText, /\[0\].*Click/);
    assert.match(state.domText, /\[1\].*Link/);
  });

  it('flags expired sessions', () => {
    const session = new BrowserSession(async () => makeStubRunner(), {
      runId: 'r1', sessionId: 's1', userDataDir: '/tmp', timeoutMs: 1,
    });
    const future = Date.now() + 1_000;
    assert.equal(session.isExpired(future), true);
  });

  it('rejects calls after close()', async () => {
    const session = new BrowserSession(async () => makeStubRunner(), {
      runId: 'r1', sessionId: 's1', userDataDir: '/tmp',
    });
    await session.navigate({ url: 'https://example.com' });
    await session.close();
    await assert.rejects(() => session.click(0), /session-closed/);
  });

  it('produces a serialized DOM with expected shape', async () => {
    const session = new BrowserSession(async () => makeStubRunner(), {
      runId: 'r1', sessionId: 's1', userDataDir: '/tmp',
    });
    const state = await session.navigate({ url: 'https://x' });
    assert.equal(state.tabs.length, 1);
    assert.equal(state.scroll.viewportHeight, 600);
  });
});

describe('BrowserSessionRegistry', () => {
  it('reuses sessions for the same (runId, sessionId)', () => {
    const reg = new BrowserSessionRegistry(async () => makeStubRunner());
    const a = reg.acquire({ runId: 'r1', sessionId: 's1', userDataDir: '/tmp' });
    const b = reg.acquire({ runId: 'r1', sessionId: 's1', userDataDir: '/tmp' });
    assert.strictEqual(a, b);
  });

  it('returns undefined for an unknown session', () => {
    const reg = new BrowserSessionRegistry(async () => makeStubRunner());
    assert.equal(reg.get('r1', 's1'), undefined);
  });

  it('release() closes the session', async () => {
    const reg = new BrowserSessionRegistry(async () => makeStubRunner());
    reg.acquire({ runId: 'r1', sessionId: 's1', userDataDir: '/tmp' });
    await reg.release('r1', 's1');
    assert.equal(reg.get('r1', 's1'), undefined);
  });

  it('sweepExpired drops stale sessions', async () => {
    const reg = new BrowserSessionRegistry(async () => makeStubRunner());
    reg.acquire({ runId: 'r1', sessionId: 's1', userDataDir: '/tmp', timeoutMs: 1 });
    const cleaned = await reg.sweepExpired(Date.now() + 1_000);
    assert.equal(cleaned, 1);
  });
});
