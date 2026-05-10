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
import { WebSearchAdapter, type WebSearchAdapterOpts } from './web-search.js';
import { WebFetchAdapter } from './web-fetch.js';
import type { SummarizerInvoker } from './summarizer.js';

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
    // Tier 2 browser backends land in Phase H4–H6.
  };
}
