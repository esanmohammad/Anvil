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
import { filterByDomainAllowList, filterByDomainBlockList, } from '@esankhan3/anvil-agent-core';
export class WebSearchAdapter {
    provider;
    /** API key for key-based providers; SearxNG base URL for the
     *  searxng provider (key reused as the credential slot to avoid
     *  per-provider state). For SearxNG with a hardened public
     *  instance, `apiKey` is the optional bearer token. */
    apiKey;
    /** SearxNG base URL when provider === 'searxng'. Empty for others. */
    baseUrl;
    httpFetch;
    constructor(opts = {}) {
        const env = (key) => opts.envOverride?.[key] ?? process.env[key];
        const detected = detectProvider(opts.provider, env);
        this.provider = detected.provider;
        this.apiKey = detected.apiKey;
        this.baseUrl = detected.baseUrl ?? '';
        this.httpFetch = opts.fetch ?? fetch;
    }
    async search(args) {
        const limit = args.limit ?? 10;
        const raw = await this.dispatch(args, limit);
        let results = raw;
        results = filterByDomainAllowList(results, args.allowedDomains);
        results = filterByDomainBlockList(results, args.blockedDomains);
        if (results.length > limit)
            results = results.slice(0, limit);
        return { query: args.query, results, resultCount: results.length };
    }
    async dispatch(args, limit) {
        switch (this.provider) {
            case 'brave':
                return this.searchBrave(args, limit);
            case 'tavily':
                return this.searchTavily(args, limit);
            case 'exa':
                return this.searchExa(args, limit);
            case 'serpapi':
                return this.searchSerpApi(args, limit);
            case 'searxng':
                return this.searchSearxng(args, limit);
        }
    }
    async searchBrave(args, limit) {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', args.query);
        url.searchParams.set('count', String(Math.min(limit, 20)));
        const res = await this.httpFetch(url, {
            headers: { 'X-Subscription-Token': this.apiKey, Accept: 'application/json' },
        });
        if (!res.ok)
            throw new Error(`Brave search failed: ${res.status}`);
        const body = await res.json();
        const out = (body.web?.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
        }));
        return out;
    }
    async searchTavily(args, limit) {
        const res = await this.httpFetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: this.apiKey,
                query: args.query,
                max_results: Math.min(limit, 25),
            }),
        });
        if (!res.ok)
            throw new Error(`Tavily search failed: ${res.status}`);
        const body = await res.json();
        return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
    }
    async searchExa(args, limit) {
        const res = await this.httpFetch('https://api.exa.ai/search', {
            method: 'POST',
            headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: args.query, numResults: Math.min(limit, 25) }),
        });
        if (!res.ok)
            throw new Error(`Exa search failed: ${res.status}`);
        const body = await res.json();
        return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.text }));
    }
    async searchSerpApi(args, limit) {
        const url = new URL('https://serpapi.com/search.json');
        url.searchParams.set('q', args.query);
        url.searchParams.set('num', String(Math.min(limit, 25)));
        url.searchParams.set('api_key', this.apiKey);
        const res = await this.httpFetch(url);
        if (!res.ok)
            throw new Error(`SerpAPI search failed: ${res.status}`);
        const body = await res.json();
        return (body.organic_results ?? []).map((r) => ({
            title: r.title,
            url: r.link,
            snippet: r.snippet,
        }));
    }
    /**
     * SearxNG — free, self-hostable, privacy-respecting metasearch.
     * Reads from `<base>/search?q=...&format=json`. The optional
     * `SEARXNG_API_KEY` is forwarded as `Authorization: Bearer …` for
     * hardened public instances; absent for default unauthenticated
     * use.
     */
    async searchSearxng(args, limit) {
        if (!this.baseUrl) {
            throw new Error('web_search: searxng provider requires SEARXNG_BASE_URL');
        }
        const trimmed = this.baseUrl.replace(/\/+$/, '');
        const url = new URL(`${trimmed}/search`);
        url.searchParams.set('q', args.query);
        url.searchParams.set('format', 'json');
        const headers = { Accept: 'application/json' };
        if (this.apiKey)
            headers.Authorization = `Bearer ${this.apiKey}`;
        const res = await this.httpFetch(url, { headers });
        if (!res.ok)
            throw new Error(`SearxNG search failed: ${res.status}`);
        let body;
        try {
            body = await res.json();
        }
        catch {
            throw new Error('SearxNG returned non-JSON. Enable JSON output in your instance config: ' +
                '`search.formats: [json]` in `settings.yml`.');
        }
        return (body.results ?? [])
            .filter((r) => typeof r.title === 'string' && typeof r.url === 'string')
            .slice(0, limit)
            .map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
    }
}
function detectProvider(pinned, env) {
    // Order matters — SearxNG goes last so users with paid Brave / Tavily
    // / Exa keys still get their preferred provider when both are set.
    const envMap = [
        ['brave', 'BRAVE_SEARCH_API_KEY'],
        ['tavily', 'TAVILY_API_KEY'],
        ['exa', 'EXA_API_KEY'],
        ['serpapi', 'SERPAPI_API_KEY'],
        ['searxng', 'SEARXNG_BASE_URL'],
    ];
    if (pinned) {
        const entry = envMap.find(([p]) => p === pinned);
        const credential = entry ? env(entry[1]) : undefined;
        if (!credential) {
            throw new Error(`web_search: provider "${pinned}" requested but ${entry?.[1] ?? '<env>'} not set`);
        }
        if (pinned === 'searxng') {
            return { provider: pinned, apiKey: env('SEARXNG_API_KEY') ?? '', baseUrl: credential };
        }
        return { provider: pinned, apiKey: credential };
    }
    for (const [p, key] of envMap) {
        const v = env(key);
        if (!v)
            continue;
        if (p === 'searxng') {
            return { provider: p, apiKey: env('SEARXNG_API_KEY') ?? '', baseUrl: v };
        }
        return { provider: p, apiKey: v };
    }
    throw new Error('web_search: no search provider configured. Set BRAVE_SEARCH_API_KEY, ' +
        'TAVILY_API_KEY, EXA_API_KEY, SERPAPI_API_KEY, or SEARXNG_BASE_URL.');
}
//# sourceMappingURL=web-search.js.map