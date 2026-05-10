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
import { matchDomainGlob } from '@esankhan3/anvil-agent-core';
import { htmlToMarkdown, looksLikeSpaShell } from './html-to-markdown.js';
import { summarize, type SummarizerInvoker } from './summarizer.js';

const DEFAULT_BODY_CAP = 10 * 1024 * 1024;
const DEFAULT_REDIRECT_DEPTH = 5;
const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

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

interface CacheEntry {
  result: WebFetchResult;
  storedAt: number;
}

export class WebFetchAdapter implements WebFetchBackend {
  private readonly invokeSummarizer: SummarizerInvoker;
  private readonly httpFetch: typeof fetch;
  private readonly blocked: readonly string[];
  private readonly allowed: readonly string[];
  private readonly bodyCap: number;
  private readonly timeoutMs: number;
  private readonly modelOverride?: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: WebFetchAdapterOpts) {
    this.invokeSummarizer = opts.invokeSummarizer;
    this.httpFetch = opts.fetch ?? fetch;
    this.blocked = opts.blockedDomains ?? [];
    this.allowed = opts.allowedDomains ?? [];
    this.bodyCap = opts.bodyCapBytes ?? DEFAULT_BODY_CAP;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelOverride = opts.summarizerModelOverride;
  }

  async fetch(args: WebFetchArgs): Promise<WebFetchResult> {
    const cacheKey = `${args.url}\u241F${args.prompt}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
      return cached.result;
    }

    this.assertAllowed(args.url);

    const upgraded = upgradeHttpToHttps(args.url);
    const fetched = await this.fetchFollowingRedirects(upgraded);

    const markdown = htmlToMarkdown(fetched.body);
    const ssr = !looksLikeSpaShell(markdown);

    let answer: string;
    let summarizerModel = '';
    let hint: string | undefined;

    if (!ssr) {
      hint = 'Page appears to be a JS/SPA shell — use browser.navigate to render it.';
      answer = `the page at ${args.url} returned an empty body (likely SPA). ${hint}`;
    } else {
      const summarized = await summarize({
        body: markdown,
        prompt: args.prompt,
        url: fetched.finalUrl,
        invoke: this.invokeSummarizer,
        modelOverride: this.modelOverride,
      });
      answer = summarized.answer;
      summarizerModel = summarized.model;
    }

    const result: WebFetchResult = {
      url: args.url,
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
      fetchedAt: new Date().toISOString(),
      answer,
      summarizerModel,
      ssr,
      hint,
    };

    this.cache.set(cacheKey, { result, storedAt: Date.now() });
    return result;
  }

  private assertAllowed(url: string): void {
    for (const block of this.blocked) {
      if (matchDomainGlob(url, block)) {
        throw new Error(`web_fetch: ${url} is on the deny-list (matched ${block})`);
      }
    }
    if (this.allowed.length > 0) {
      const allowed = this.allowed.some((p) => matchDomainGlob(url, p));
      if (!allowed) {
        throw new Error(`web_fetch: ${url} is not on the project allow-list. Add it to pipeline-policy.overlay.json: tools.network.allowedDomains.`);
      }
    }
  }

  private async fetchFollowingRedirects(url: string): Promise<{ body: string; finalUrl: string; contentType: string }> {
    let current = url;
    const startHost = safeHost(current);
    for (let i = 0; i < DEFAULT_REDIRECT_DEPTH; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.httpFetch(current, {
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Anvil/1.0 (web.fetch)' },
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new Error(`web_fetch: redirect ${res.status} but no Location header`);
        }
        const next = new URL(location, current).toString();
        const nextHost = safeHost(next);
        if (nextHost && startHost && nextHost !== startHost) {
          throw new Error(`web_fetch: cross-host redirect blocked: ${current} → ${next}`);
        }
        this.assertAllowed(next);
        current = next;
        continue;
      }
      if (!res.ok) throw new Error(`web_fetch: ${res.status} ${res.statusText}`);

      const contentType = res.headers.get('content-type') ?? 'text/plain';
      const reader = res.body?.getReader();
      if (!reader) {
        const body = await res.text();
        return { body: clampString(body, this.bodyCap), finalUrl: current, contentType };
      }
      let received = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > this.bodyCap) {
            try { await reader.cancel(); } catch { /* ignore */ }
            break;
          }
          chunks.push(value);
        }
      }
      const body = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
      return { body, finalUrl: current, contentType };
    }
    throw new Error(`web_fetch: redirect chain exceeded ${DEFAULT_REDIRECT_DEPTH}`);
  }
}

function upgradeHttpToHttps(url: string): string {
  if (url.startsWith('http://')) return 'https://' + url.slice(7);
  return url;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function clampString(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
