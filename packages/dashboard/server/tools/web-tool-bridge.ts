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
import { getCurrentStepContext } from '@esankhan3/anvil-agent-core';

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
   *  `tools.browseHeadless.contexts`). Static fallback when
   *  `getAllowedContexts` isn't supplied. */
  allowedContexts?: readonly string[];
  /** Per-project allow-list resolver — invoked at call time with the
   *  project slug derived from the active step context. Production
   *  wires `loadPolicy(slug).tools?.browseHeadless?.contexts ?? []`. */
  getAllowedContexts?: (projectSlug: string) => readonly string[] | undefined;
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
        void ctx;
        return cachedSearch.search(args);
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
  /** Canonical Anvil project slug. Resolved from the active step
   *  context at call time when omitted by the caller. */
  projectSlug?: string;
}

/**
 * Enrich the executor-supplied ExecCtx with `runId` / `sessionId` /
 * `projectSlug` from the active step context. Without this,
 * `WebToolExecutor` invokes backends with no run identity, collapsing
 * every Tier 2 session into a single shared one.
 */
function enrichCtx<T extends BrowserBackendCtx>(ctx: T): T {
  if (ctx.runId && ctx.sessionId && ctx.projectSlug) return ctx;
  const stepCtx = getCurrentStepContext() as
    | { runId?: string; project?: string; sessionId?: string }
    | undefined;
  return {
    ...ctx,
    runId: ctx.runId ?? stepCtx?.runId ?? 'standalone',
    sessionId: ctx.sessionId ?? stepCtx?.sessionId ?? `s-${stepCtx?.runId ?? 'global'}`,
    projectSlug: ctx.projectSlug ?? stepCtx?.project,
  };
}

function resolveProjectSlug(ctx: BrowserBackendCtx): string {
  if (ctx.projectSlug) return ctx.projectSlug;
  const stepCtx = getCurrentStepContext() as { project?: string } | undefined;
  return stepCtx?.project ?? 'default';
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
      const enriched = enrichCtx(ctx);
      // Phase H8 + H10-followup #9 — confirm-gate Tier 3 actions.
      // `sessionKey` lets the user approve "all computer_use calls
      // for this run/session" once instead of N modals per action.
      await confirmGate.confirm({
        tool: 'computer_use',
        description: `Tier 3 pixel browser action: ${a.action ?? '?'}`,
        risk: 'high',
        payload: action,
        sessionKey: `computer:${enriched.runId}:${enriched.sessionId}`,
      });
      const runner = await ensure(enriched.runId!);
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
  // projectSlug is now resolved per-call via `resolveProjectSlug(ctx)`,
  // not at backend construction time, so allowedContexts can read live
  // pipeline-policy state.

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
    const enriched = enrichCtx(ctx);
    const runId = enriched.runId!;
    const sessionId = enriched.sessionId!;
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
      const enriched = enrichCtx(ctx);
      const runId = enriched.runId!;
      const sessionId = enriched.sessionId!;
      await registry.release(runId, sessionId);
      clearSessionState(enriched);
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
      // Allow-list resolution (H10-followup #4):
      //   1. Caller-supplied callback `getAllowedContexts(projectSlug)`
      //      — dashboard reads project policy at runtime.
      //   2. Static `allowedContexts` from the bridge constructor.
      //   3. None — assertAllowed throws.
      const proj = resolveProjectSlug(ctx);
      const allowed = opts.getAllowedContexts?.(proj) ?? opts.allowedContexts;
      contextStore.assertAllowed(args.name, allowed);
      await confirmGate.confirm({
        tool: 'browser_attach_context',
        description: `Attach saved auth context "${args.name}" to the running session.`,
        risk: 'medium',
        payload: { name: args.name },
      });
      const meta = contextStore.read(proj, args.name);
      if (!meta) {
        throw new Error(`browser context "${args.name}" not found. Run \`anvil browser login ${args.name} <url>\`.`);
      }
      // H10-followup #1 — actually load the cookies. Close the current
      // session and acquire a new one with `storageStatePath` set so
      // the next navigate() lands authenticated. The agent must call
      // attach_context BEFORE the meaningful navigation.
      const runId = ctx.runId ?? 'standalone';
      const sessionId = ctx.sessionId ?? `s-${randomUUID()}`;
      await registry.release(runId, sessionId);
      clearSessionState(ctx);
      const userDataDir = join(homedir(), '.anvil', 'browser', runId, sessionId);
      const session = registry.acquire({
        runId, sessionId, userDataDir, headless: true,
        storageStatePath: contextStore.storageStatePath(proj, args.name),
      });
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
