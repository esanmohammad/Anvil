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
import { ConfirmGate, type ConfirmRequest } from '../browser/confirm-gate.js';
import { ContextStore } from '../browser/contexts.js';
import { NoProgressDetector, RateLimiter, RateLimitError } from '../browser/no-progress-detector.js';
import { createHash } from 'node:crypto';
import type { ComputerRunnerFactory, ComputerRunner } from '../computer-use/docker-runner.js';

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
  /** Async confirmer for `browser_evaluate` / `browser_attach_context` /
   *  computer.*. Test seam — production wires through the WebSocket UI. */
  confirmer?: (req: ConfirmRequest) => Promise<boolean>;
  /** Project slug for context attachment. Default `'default'`. */
  projectSlug?: string;
  /** Per-project context allow-list (overlay's
   *  `tools.browseHeadless.contexts`). */
  allowedContexts?: readonly string[];
  /** Tier 3 — Docker-backed computer-use runner factory. When omitted,
   *  Tier 3 tools aren't advertised. */
  computerRunnerFactory?: ComputerRunnerFactory;
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
    computer: opts.computerRunnerFactory ? createComputerBackend(opts) : undefined,
  };
}

interface BrowserBackendCtx {
  runId?: string;
  sessionId?: string;
}

function createComputerBackend(opts: WebToolBridgeOpts) {
  const factory = opts.computerRunnerFactory!;
  const confirmGate = new ConfirmGate({ ask: opts.confirmer });
  const runners = new Map<string, ComputerRunner>();

  async function ensure(runId: string): Promise<ComputerRunner> {
    let r = runners.get(runId);
    if (!r) { r = await factory({ runId }); runners.set(runId, r); }
    return r;
  }

  return {
    async do(action: unknown, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const a = action as { action?: string };
      // Phase H8 — every Tier 3 action goes through the confirm gate.
      await confirmGate.confirm({
        tool: 'computer_use',
        description: `Tier 3 pixel browser action: ${a.action ?? '?'}`,
        risk: 'high',
        payload: action,
      });
      const runId = ctx.runId ?? 'standalone';
      const runner = await ensure(runId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return runner.do(action as any);
    },
  };
}

function createBrowserBackend(opts: WebToolBridgeOpts) {
  const factory = opts.browserRunnerFactory ?? createPlaywrightRunner;
  const registry = new BrowserSessionRegistry(factory);
  const confirmGate = new ConfirmGate({ ask: opts.confirmer });
  const contextStore = new ContextStore();
  const projectSlug = opts.projectSlug ?? 'default';

  // Phase H7 — per-session no-progress detector + rate limiters.
  // Keyed on (runId, sessionId) so multiple concurrent sessions don't
  // share state.
  const detectors = new Map<string, NoProgressDetector>();
  const clickLimits = new Map<string, RateLimiter>();
  const screenshotLimits = new Map<string, RateLimiter>();

  function sessionKey(ctx: BrowserBackendCtx): string {
    return `${ctx.runId ?? 'standalone'}\u241F${ctx.sessionId ?? ''}`;
  }
  function detectorFor(ctx: BrowserBackendCtx): NoProgressDetector {
    const k = sessionKey(ctx);
    let d = detectors.get(k);
    if (!d) { d = new NoProgressDetector(); detectors.set(k, d); }
    return d;
  }
  function clickLimitFor(ctx: BrowserBackendCtx): RateLimiter {
    const k = sessionKey(ctx);
    let r = clickLimits.get(k);
    if (!r) { r = new RateLimiter(1, 1000); clickLimits.set(k, r); }
    return r;
  }
  function screenshotLimitFor(ctx: BrowserBackendCtx): RateLimiter {
    const k = sessionKey(ctx);
    let r = screenshotLimits.get(k);
    if (!r) { r = new RateLimiter(6, 60_000); screenshotLimits.set(k, r); }
    return r;
  }

  function recordProgress(ctx: BrowserBackendCtx, kind: string, state: { url: string; domText: string }): void {
    const tuple = {
      url: state.url,
      viewportHash: createHash('sha256').update(state.domText).digest('hex').slice(0, 16),
      lastInteractionType: kind,
    };
    const r = detectorFor(ctx).observe(tuple);
    if (r.stalled && state) {
      // Annotate the state so the agent sees the warning.
      Object.assign(state, {
        domText: `[__anvilBrowseStalled — ${r.streak} actions without progress; consider browser_done]\n${state.domText}`,
      });
    }
  }

  function acquire(ctx: BrowserBackendCtx) {
    const runId = ctx.runId ?? 'standalone';
    const sessionId = ctx.sessionId ?? `s-${randomUUID()}`;
    const userDataDir = join(homedir(), '.anvil', 'browser', runId, sessionId);
    return registry.acquire({ runId, sessionId, userDataDir, headless: true });
  }

  function clearSessionState(ctx: BrowserBackendCtx): void {
    const k = sessionKey(ctx);
    detectors.delete(k);
    clickLimits.delete(k);
    screenshotLimits.delete(k);
  }
  void RateLimitError;

  return {
    async navigate(args: import('@esankhan3/anvil-core-pipeline').BrowserNavigateArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const state = await session.navigate({ url: args.url, newTab: args.newTab, timeoutMs: args.timeoutMs });
      recordProgress(ctx, 'navigate', state);
      return state;
    },
    async click(args: import('@esankhan3/anvil-core-pipeline').BrowserClickArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      clickLimitFor(ctx).consume();
      const session = acquire(ctx);
      const state = await session.click(args.index);
      recordProgress(ctx, 'click', state);
      return state;
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
      clearSessionState(ctx);
    },
    async screenshot(args: import('@esankhan3/anvil-core-pipeline').BrowserScreenshotArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      screenshotLimitFor(ctx).consume();
      const session = acquire(ctx);
      const runner = await session.getRunner();
      const r = await runner.screenshot(args);
      return { ...r, capturedAt: new Date().toISOString() };
    },
    async evaluate(args: import('@esankhan3/anvil-core-pipeline').BrowserEvaluateArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      // Phase H6 — confirm-required for arbitrary JS.
      await confirmGate.confirm({
        tool: 'browser_evaluate',
        description: 'Evaluate JavaScript in the page context (high risk: can read storage, exfiltrate data).',
        risk: 'high',
        payload: { expression: args.expression.slice(0, 500) },
      });
      const session = acquire(ctx);
      const runner = await session.getRunner();
      return runner.evaluate(args);
    },
    async attachContext(args: { name: string }, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      // Phase H6 — confirm + per-project allow-list check.
      contextStore.assertAllowed(args.name, opts.allowedContexts);
      await confirmGate.confirm({
        tool: 'browser_attach_context',
        description: `Attach saved auth context "${args.name}" to the running session.`,
        risk: 'medium',
        payload: { name: args.name },
      });
      const meta = contextStore.read(projectSlug, args.name);
      if (!meta) {
        throw new Error(`browser context "${args.name}" not found. Run \`anvil browser login ${args.name} <url>\`.`);
      }
      const session = acquire(ctx);
      // Snapshot to surface current state; actual cookie injection is
      // Playwright-runner-specific and lands when the runner gains a
      // `loadStorageState` method (deferred).
      return session.navigate({ url: meta.url });
    },
    async searchPage(args: import('@esankhan3/anvil-core-pipeline').BrowserSearchPageArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      return runner.searchPage(args);
    },
    async extract(args: import('@esankhan3/anvil-core-pipeline').BrowserExtractArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      if (!opts.summarizerInvoker) {
        throw new Error('browser_extract: extractor invoker not wired. Set summarizerInvoker on createWebToolBridge.');
      }
      const session = acquire(ctx);
      const runner = await session.getRunner();
      const snap = await runner.snapshot();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { serializeDom } = await import('../browser/dom-serializer.js');
      const ser = serializeDom(snap.domRoot);
      const { extract } = await import('../browser/extractor.js');
      return extract(args, { pageText: ser.domText, invoke: opts.summarizerInvoker });
    },
    async consoleMessages(args: import('@esankhan3/anvil-core-pipeline').BrowserConsoleArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      return runner.consoleMessages(args);
    },
    async networkRequests(args: import('@esankhan3/anvil-core-pipeline').BrowserNetworkArgs, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      return runner.networkRequests(args);
    },
    async newTab(args: { url?: string }, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      const snap = await runner.newTab(args);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { serializeDom } = await import('../browser/dom-serializer.js');
      return {
        url: snap.url, title: snap.title,
        domText: serializeDom(snap.domRoot).domText, axText: snap.axText ?? '',
        tabs: snap.tabs, scroll: snap.scroll, effectIdx: 0,
      };
    },
    async closeTab(args: { tabId: string }, ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      const snap = await runner.closeTab(args);
      const { serializeDom } = await import('../browser/dom-serializer.js');
      return {
        url: snap.url, title: snap.title,
        domText: serializeDom(snap.domRoot).domText, axText: snap.axText ?? '',
        tabs: snap.tabs, scroll: snap.scroll, effectIdx: 0,
      };
    },
    async tabs(ctx: { workingDir: string; abortSignal: AbortSignal } & BrowserBackendCtx) {
      const session = acquire(ctx);
      const runner = await session.getRunner();
      return runner.tabs();
    },
  };
}
