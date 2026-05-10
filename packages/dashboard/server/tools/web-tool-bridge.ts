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

export interface WebToolBridgeOpts {
  /** Pinned search provider; auto-detected when omitted. */
  searchProvider?: WebSearchAdapterOpts['provider'];
  /** Fetch override (test seam). */
  fetch?: typeof fetch;
}

/**
 * Build a memoized `WebToolBackends` bag. Backends are only realized on
 * first call; throws (well, the search/fetch promise rejects) if no
 * provider is configured.
 */
export function createWebToolBridge(opts: WebToolBridgeOpts = {}): WebToolBackends {
  let cachedSearch: WebSearchAdapter | undefined;
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
    // Tier 1 fetch backend lands in Phase H2.
    // Tier 2 browser backends land in Phase H4–H6.
  };
}
