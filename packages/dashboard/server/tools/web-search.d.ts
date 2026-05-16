/**
 * Backend adapter for `web.search`. Dispatches to one of:
 *   - Brave Search API (default; cheap; needs BRAVE_SEARCH_API_KEY).
 *   - Exa (semantic; needs EXA_API_KEY).
 *   - Tavily (AI-native; free tier; needs TAVILY_API_KEY).
 *   - SerpAPI (needs SERPAPI_API_KEY).
 *   - SearxNG (free / self-hostable; needs SEARXNG_BASE_URL).
 *
 * Resolution order:
 *   1. `~/.anvil/web-search.yaml` `provider:` field (if present).
 *   2. First env var found in [Brave, Tavily, Exa, SerpAPI, SearxNG] order.
 *      SearxNG goes last so users who explicitly paid for Brave / Tavily /
 *      Exa get their preferred provider; SearxNG is the catch-all when
 *      nothing else is wired.
 *   3. Throws — caller bubbles a friendly error to the agent.
 *
 * The executor wraps the backend's response in the canonical
 * `WebSearchResult` shape and applies post-fetch domain allow/block
 * filtering (so backends that don't support per-call filters still
 * honor the project's policy overlay).
 */
import type { WebSearchArgs, WebSearchResult } from '@esankhan3/anvil-core-pipeline';
import { type WebSearchBackend } from '@esankhan3/anvil-agent-core';
export type WebSearchProvider = 'brave' | 'exa' | 'tavily' | 'serpapi' | 'searxng';
export interface WebSearchAdapterOpts {
    /** Pinned provider; falls back to env-var auto-detect when absent. */
    provider?: WebSearchProvider;
    /** Custom HTTP fetch (test seam). */
    fetch?: typeof fetch;
    /** Override env lookup (test seam). */
    envOverride?: Partial<Record<string, string>>;
}
export declare class WebSearchAdapter implements WebSearchBackend {
    private readonly provider;
    /** API key for key-based providers; SearxNG base URL for the
     *  searxng provider (key reused as the credential slot to avoid
     *  per-provider state). For SearxNG with a hardened public
     *  instance, `apiKey` is the optional bearer token. */
    private readonly apiKey;
    /** SearxNG base URL when provider === 'searxng'. Empty for others. */
    private readonly baseUrl;
    private readonly httpFetch;
    constructor(opts?: WebSearchAdapterOpts);
    search(args: WebSearchArgs): Promise<WebSearchResult>;
    private dispatch;
    private searchBrave;
    private searchTavily;
    private searchExa;
    private searchSerpApi;
    /**
     * SearxNG — free, self-hostable, privacy-respecting metasearch.
     * Reads from `<base>/search?q=...&format=json`. The optional
     * `SEARXNG_API_KEY` is forwarded as `Authorization: Bearer …` for
     * hardened public instances; absent for default unauthenticated
     * use.
     */
    private searchSearxng;
}
//# sourceMappingURL=web-search.d.ts.map