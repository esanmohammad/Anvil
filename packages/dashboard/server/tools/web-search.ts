/**
 * Backend adapter for `web.search`. Dispatches to one of:
 *   - Brave Search API (default; cheap; needs BRAVE_SEARCH_API_KEY).
 *   - Exa (semantic; needs EXA_API_KEY).
 *   - Tavily (AI-native; free tier; needs TAVILY_API_KEY).
 *   - SerpAPI (needs SERPAPI_API_KEY).
 *
 * Resolution order:
 *   1. `~/.anvil/web-search.yaml` `provider:` field (if present).
 *   2. First env var found in [Brave, Tavily, Exa, SerpAPI] order.
 *   3. Throws — caller bubbles a friendly error to the agent.
 *
 * The executor wraps the backend's response in the canonical
 * `WebSearchResult` shape and applies post-fetch domain allow/block
 * filtering (so backends that don't support per-call filters still
 * honor the project's policy overlay).
 */

import type {
  WebSearchArgs,
  WebSearchResult,
  WebSearchHit,
} from '@esankhan3/anvil-core-pipeline';
import {
  filterByDomainAllowList,
  filterByDomainBlockList,
  type WebSearchBackend,
} from '@esankhan3/anvil-agent-core';

export type WebSearchProvider = 'brave' | 'exa' | 'tavily' | 'serpapi';

export interface WebSearchAdapterOpts {
  /** Pinned provider; falls back to env-var auto-detect when absent. */
  provider?: WebSearchProvider;
  /** Custom HTTP fetch (test seam). */
  fetch?: typeof fetch;
  /** Override env lookup (test seam). */
  envOverride?: Partial<Record<string, string>>;
}

export class WebSearchAdapter implements WebSearchBackend {
  private readonly provider: WebSearchProvider;
  private readonly apiKey: string;
  private readonly httpFetch: typeof fetch;

  constructor(opts: WebSearchAdapterOpts = {}) {
    const env = (key: string): string | undefined => opts.envOverride?.[key] ?? process.env[key];
    const detected = detectProvider(opts.provider, env);
    this.provider = detected.provider;
    this.apiKey = detected.apiKey;
    this.httpFetch = opts.fetch ?? fetch;
  }

  async search(args: WebSearchArgs, _ctx?: unknown): Promise<WebSearchResult> {
    void _ctx;
    const limit = args.limit ?? 10;
    const raw = await this.dispatch(args, limit);
    let results: WebSearchHit[] = raw;
    results = filterByDomainAllowList(results, args.allowedDomains) as WebSearchHit[];
    results = filterByDomainBlockList(results, args.blockedDomains) as WebSearchHit[];
    if (results.length > limit) results = results.slice(0, limit);
    return { query: args.query, results, resultCount: results.length };
  }

  private async dispatch(args: WebSearchArgs, limit: number): Promise<WebSearchHit[]> {
    switch (this.provider) {
      case 'brave':
        return this.searchBrave(args, limit);
      case 'tavily':
        return this.searchTavily(args, limit);
      case 'exa':
        return this.searchExa(args, limit);
      case 'serpapi':
        return this.searchSerpApi(args, limit);
    }
  }

  private async searchBrave(args: WebSearchArgs, limit: number): Promise<WebSearchHit[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', args.query);
    url.searchParams.set('count', String(Math.min(limit, 20)));
    const res = await this.httpFetch(url, {
      headers: { 'X-Subscription-Token': this.apiKey, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
    const body = await res.json() as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    const out = (body.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }));
    return out;
  }

  private async searchTavily(args: WebSearchArgs, limit: number): Promise<WebSearchHit[]> {
    const res = await this.httpFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: args.query,
        max_results: Math.min(limit, 25),
      }),
    });
    if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
    const body = await res.json() as { results?: Array<{ title: string; url: string; content?: string }> };
    return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
  }

  private async searchExa(args: WebSearchArgs, limit: number): Promise<WebSearchHit[]> {
    const res = await this.httpFetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: args.query, numResults: Math.min(limit, 25) }),
    });
    if (!res.ok) throw new Error(`Exa search failed: ${res.status}`);
    const body = await res.json() as { results?: Array<{ title: string; url: string; text?: string }> };
    return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.text }));
  }

  private async searchSerpApi(args: WebSearchArgs, limit: number): Promise<WebSearchHit[]> {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('q', args.query);
    url.searchParams.set('num', String(Math.min(limit, 25)));
    url.searchParams.set('api_key', this.apiKey);
    const res = await this.httpFetch(url);
    if (!res.ok) throw new Error(`SerpAPI search failed: ${res.status}`);
    const body = await res.json() as {
      organic_results?: Array<{ title: string; link: string; snippet?: string }>;
    };
    return (body.organic_results ?? []).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));
  }
}

function detectProvider(
  pinned: WebSearchProvider | undefined,
  env: (k: string) => string | undefined,
): { provider: WebSearchProvider; apiKey: string } {
  const envMap: Array<[WebSearchProvider, string]> = [
    ['brave', 'BRAVE_SEARCH_API_KEY'],
    ['tavily', 'TAVILY_API_KEY'],
    ['exa', 'EXA_API_KEY'],
    ['serpapi', 'SERPAPI_API_KEY'],
  ];
  if (pinned) {
    const entry = envMap.find(([p]) => p === pinned);
    const apiKey = entry ? env(entry[1]) : undefined;
    if (!apiKey) {
      throw new Error(`web_search: provider "${pinned}" requested but ${entry?.[1] ?? '<env>'} not set`);
    }
    return { provider: pinned, apiKey };
  }
  for (const [p, key] of envMap) {
    const v = env(key);
    if (v) return { provider: p, apiKey: v };
  }
  throw new Error(
    'web_search: no search provider configured. Set BRAVE_SEARCH_API_KEY, ' +
    'TAVILY_API_KEY, EXA_API_KEY, or SERPAPI_API_KEY.',
  );
}
