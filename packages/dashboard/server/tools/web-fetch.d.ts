/**
 * `web.fetch` backend. Fetches the URL, converts HTML→Markdown, runs
 * the summarizer, returns a paraphrased answer. Caches by
 * `(url, prompt, summarizerModel)` for 15 min.
 *
 * Defenses:
 *   - HTTP→HTTPS upgrade attempted; falls back to original on failure.
 *   - Redirects followed within the same registered host.
 *   - 10 MB body cap.
 *   - Domain deny-list / allow-list applied at fetch time.
 *   - SPA detection: if the body looks like an empty client-side shell,
 *     return `{ssr:false, hint}` so the agent can escalate to Tier 2.
 *   - Strip-on-read: html-to-markdown drops `<script>`, event handlers, etc.
 */
import type { WebFetchArgs, WebFetchResult } from '@esankhan3/anvil-core-pipeline';
import type { WebFetchBackend } from '@esankhan3/anvil-agent-core';
import { type SummarizerInvoker } from './summarizer.js';
export interface WebFetchAdapterOpts {
    /** LLM caller for the summarizer (test seam + dashboard wiring). */
    invokeSummarizer: SummarizerInvoker;
    /** Test seam — replace `fetch` for unit tests. */
    fetch?: typeof fetch;
    /** Hostname patterns blocked at fetch time. */
    blockedDomains?: readonly string[];
    /** Hostname patterns explicitly allowed (when set, others are blocked). */
    allowedDomains?: readonly string[];
    /** Override body cap (default 10 MB). */
    bodyCapBytes?: number;
    /** Override request timeout (default 30s). */
    timeoutMs?: number;
    /** Skip the stage resolver and use this model id (test seam). */
    summarizerModelOverride?: string;
}
export declare class WebFetchAdapter implements WebFetchBackend {
    private readonly invokeSummarizer;
    private readonly httpFetch;
    private readonly blocked;
    private readonly allowed;
    private readonly bodyCap;
    private readonly timeoutMs;
    private readonly modelOverride?;
    private readonly cache;
    constructor(opts: WebFetchAdapterOpts);
    fetch(args: WebFetchArgs): Promise<WebFetchResult>;
    private assertAllowed;
    private fetchFollowingRedirects;
}
//# sourceMappingURL=web-fetch.d.ts.map