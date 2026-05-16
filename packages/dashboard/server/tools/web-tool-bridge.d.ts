/**
 * Bridge between agent-core's `WebToolBackends` shape and the dashboard's
 * concrete adapters. Constructed once per pipeline runner and passed
 * into every spawn that includes web tools in its allow-list.
 *
 * Backends are lazily memoized — search/fetch/extract clients build only
 * when first invoked. Construction is cheap; the lazy init just keeps
 * boot faster when a project never uses these tools.
 */
import type { WebToolBackends } from '@esankhan3/anvil-agent-core';
import { type WebSearchAdapterOpts } from './web-search.js';
import type { SummarizerInvoker } from './summarizer.js';
import { type BrowserRunnerFactory } from '../browser/session-manager.js';
import { type ConfirmRequest } from '../browser/confirm-gate.js';
import type { ComputerRunnerFactory } from '../computer-use/docker-runner.js';
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
export declare function createWebToolBridge(opts?: WebToolBridgeOpts): WebToolBackends;
//# sourceMappingURL=web-tool-bridge.d.ts.map