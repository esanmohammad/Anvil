/**
 * Bridge between agent-core's `WebToolBackends` shape and the dashboard's
 * concrete adapters. Constructed once per pipeline runner and passed
 * into every spawn that includes web tools in its allow-list.
 *
 * Backends are lazily memoized — search/fetch/extract clients build only
 * when first invoked. Construction is cheap; the lazy init just keeps
 * boot faster when a project never uses these tools.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WebToolBackends } from '@esankhan3/anvil-agent-core';
import { WebSearchAdapter, type WebSearchAdapterOpts } from './web-search.js';
import { WebFetchAdapter } from './web-fetch.js';
import type { SummarizerInvoker } from './summarizer.js';
import { BrowserSessionRegistry, type BrowserRunnerFactory } from '../browser/session-manager.js';
import { createPlaywrightRunner } from '../browser/playwright-runner.js';

export interface WebToolBridgeOpts {
  /** Pinned search provider; auto-detected when omitted. */
  searchProvider?: WebSearchAdapterOpts['provider'];
  /** Fetch override (test seam). */
  fetch?: typeof fetch;
  /** LLM caller for the summarizer (Phase H2+). When omitted, web.fetch
   *  rejects with "summarizer not wired" — useful for tests/dev that
   *  use only web.search. */
  summarizerInvoker?: SummarizerInvoker;
  /** Project-wide blocked domains for web.fetch. */
  blockedDomains?: readonly string[];
  /** Project-wide allow-list for web.fetch (when set, others are blocked). */
  allowedDomains?: readonly string[];
  /** Override the browser runner factory. Production wires Playwright;
   *  tests inject a stub. When omitted, defaults to
   *  `createPlaywrightRunner` — Playwright must be installed for Tier 2. */
  browserRunnerFactory?: BrowserRunnerFactory;
}

/**
 * Build a memoized `WebToolBackends` bag. Backends are only realized on
 * first call; throws (well, the search/fetch promise rejects) if no
 * provider is configured.
 */
export function createWebToolBridge(opts: WebToolBridgeOpts = {}): WebToolBackends {
  let cachedSearch: WebSearchAdapter | undefined;
  let cachedFetch: WebFetchAdapter | undefined;
  return {
    search: {
      async search(args, ctx) {
        if (!cachedSearch) {
          cachedSearch = new WebSearchAdapter({
            provider: opts.searchProvider,
            fetch: opts.fetch,
          });
        }
        return cachedSearch.search(args, ctx);
      },
    },
    fetch: {
      async fetch(args, _ctx) {
        if (!opts.summarizerInvoker) {
          throw new Error('web_fetch: summarizer is not wired. Set summarizerInvoker on createWebToolBridge.');
        }
        if (!cachedFetch) {
          cachedFetch = new WebFetchAdapter({
            invokeSummarizer: opts.summarizerInvoker,
            fetch: opts.fetch,
            blockedDomains: opts.blockedDomains,
            allowedDomains: opts.allowedDomains,
          });
        }
        void _ctx;
        return cachedFetch.fetch(args);
      },
    },
    browser: createBrowserBackend(opts),
  };
}

interface BrowserBackendCtx {
  runId?: string;
  sessionId?: string;
}

function createBrowserBackend(opts: WebToolBridgeOpts) {
  const factory = opts.browserRunnerFactory ?? createPlaywrightRunner;
  const registry = new BrowserSessionRegistry(factory);

  function acquire(ctx: BrowserBackendCtx) {
    const runId = ctx.runId ?? 'standalone';
    const sessionId = ctx.sessionId ?? `s-${randomUUID()}`;
    const userDataDir = join(homedir(), '.anvil', 'browser', runId, sessionId);
    return registry.acquire({ runId, sessionId, userDataDir, headless: true });
  }

  return {
    async navigate(args: import('@esankhan3/anvil-core-pipeline').BrowserNavigateArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      return session.navigate({ url: args.url, newTab: args.newTab, timeoutMs: args.timeoutMs });
    },
    async click(args: import('@esankhan3/anvil-core-pipeline').BrowserClickArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      return session.click(args.index);
    },
    async input(args: import('@esankhan3/anvil-core-pipeline').BrowserInputArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      return session.input(args.index, args.text, args.clear);
    },
    async scroll(args: import('@esankhan3/anvil-core-pipeline').BrowserScrollArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      return session.scroll(args);
    },
    async done(_args: import('@esankhan3/anvil-core-pipeline').BrowserDoneArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      void _args;
      const runId = ctx.runId ?? 'standalone';
      const sessionId = ctx.sessionId ?? '';
      if (sessionId) await registry.release(runId, sessionId);
    },
    async screenshot(args: import('@esankhan3/anvil-core-pipeline').BrowserScreenshotArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      const r = await runner.screenshot(args);
      return { ...r, capturedAt: new Date().toISOString() };
    },
    async evaluate(args: import('@esankhan3/anvil-core-pipeline').BrowserEvaluateArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      return runner.evaluate(args);
    },
    // searchPage / extract / consoleMessages / networkRequests / tabs land in
    // Phase H5+. They're advertised on the executor; missing implementations
    // produce a friendly "not implemented" response.
  };
}
