/**
 * H10-followup #2 — attach_context release-and-reacquire flow.
 * Verifies that after `browser_attach_context`, the next session is
 * configured with the saved `storageStatePath` so Playwright would
 * load the cookies (we don't run real Playwright; we assert the
 * runner factory receives the path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createWebToolBridge } from '../tools/web-tool-bridge.js';
import { withCurrentStepContext, WebToolExecutor } from '@esankhan3/anvil-agent-core';
import type { ToolCall } from '@esankhan3/anvil-agent-core';
import type { BrowserRunner, BrowserSessionOpts, RunnerSnapshot } from '../browser/session-manager.js';

function snap(url: string, title: string): RunnerSnapshot {
  return {
    url,
    title,
    domRoot: { tag: 'body', children: [{ tag: 'h1', text: title }] },
    axText: '',
    scroll: { x: 0, y: 0, pageHeight: 1, viewportHeight: 1 },
    tabs: [{ tabId: 'main', title, url, active: true }],
  };
}

function makeStubRunner(): BrowserRunner {
  return {
    async navigate({ url }) { return snap(url, 'Stub'); },
    async click() { return snap('https://x', 'Stub'); },
    async input() { return snap('https://x', 'Stub'); },
    async scroll() { return snap('https://x', 'Stub'); },
    async snapshot() { return snap('https://x', 'Stub'); },
    async searchPage() { return { hits: [] }; },
    async screenshot() { return { imageBase64: '', width: 0, height: 0 }; },
    async evaluate() { return { result: null, resolved: true }; },
    async consoleMessages() { return { messages: [] }; },
    async networkRequests() { return { requests: [] }; },
    async newTab() { return snap('https://x', 'Stub'); },
    async closeTab() { return snap('https://x', 'Stub'); },
    async tabs() { return { tabs: [] }; },
    async close() { /* */ },
  };
}

const ctx = { workingDir: '/tmp', abortSignal: new AbortController().signal };
function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'c', name, arguments: args };
}

describe('browser_attach_context release-and-reacquire', () => {
  it('configures the new runner with storageStatePath after attach', async () => {
    // Use a custom contexts root via env (ContextStore reads ~/.anvil
    // by default; we can't override that without a temp HOME, so we
    // instead pre-create the metadata at the default path and clean up.
    const project = `attach-ctx-test-${Date.now()}`;
    const ctxName = 'docs';
    const root = join(homedir(), '.anvil', 'browser', 'contexts', project, ctxName);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'metadata.json'), JSON.stringify({
      name: ctxName,
      projectSlug: project,
      url: 'https://docs.example.com/start',
      createdAt: new Date().toISOString(),
      refreshedAt: new Date().toISOString(),
    }));
    writeFileSync(join(root, 'storage-state.json'), '{"cookies":[]}');

    try {
      const factoryCalls: BrowserSessionOpts[] = [];
      const backends = createWebToolBridge({
        browserRunnerFactory: async (opts) => { factoryCalls.push(opts); return makeStubRunner(); },
        confirmer: async () => true,
        getAllowedContexts: () => [ctxName],
      });
      const exec = new WebToolExecutor({
        allowedTools: ['browser_navigate', 'browser_attach_context', 'browser_done'],
        backends,
      });

      // Attach context inside an active step ctx so projectSlug + runId
      // resolve from the step state.
      await withCurrentStepContext({ runId: 'r1', sessionId: 's1', project }, async () => {
        // First navigate to spin up the unauthenticated session.
        const nav = await exec.execute(call('browser_navigate', { url: 'https://docs.example.com/login' }), ctx);
        assert.equal(nav.isError, false);
        // Now attach — should release + reacquire with storageStatePath.
        const attach = await exec.execute(call('browser_attach_context', { name: ctxName }), ctx);
        assert.equal(attach.isError, false, `attach failed: ${attach.content}`);
      });

      // The factory should have been called twice: once for the
      // unauthenticated nav, once for the post-attach session. The
      // second call must carry storageStatePath.
      assert.equal(factoryCalls.length, 2, `expected 2 factory calls, got ${factoryCalls.length}`);
      assert.equal(factoryCalls[0].storageStatePath, undefined, 'first session has no storage state');
      assert.match(
        factoryCalls[1].storageStatePath ?? '',
        /storage-state\.json$/,
        'second session must load storage state',
      );
    } finally {
      // Clean up the test context.
      rmSync(join(homedir(), '.anvil', 'browser', 'contexts', project), { recursive: true, force: true });
    }
  });
});
