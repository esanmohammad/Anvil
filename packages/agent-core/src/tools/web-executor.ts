/**
 * Web/browser tool executor. Lives in agent-core because the bridge
 * already wires `BuiltinToolExecutor` here; the same composition
 * pattern lets us plug `web.search` / `web.fetch` / `browser.*` /
 * `computer.*` in via per-tool backends without forking the bridge.
 *
 * Backends are dependency-injected at construction time. For testing,
 * pass a deterministic stub (see `__tests__/web-executor.test.ts`); for
 * production use the dashboard wires the real implementations
 * (Brave/Exa/Tavily for search, axios + Turndown + summarizer for
 * fetch, Playwright child-process for browser, Docker Xvfb for
 * computer).
 */

import { createHash } from 'node:crypto';
import type { ToolCall, ToolSchema } from '../types.js';
import type {
  WebSearchArgs,
  WebSearchResult,
  WebFetchArgs,
  WebFetchResult,
} from '@esankhan3/anvil-core-pipeline';
import type { ExecCtx, ToolExecutor, ToolResult } from './types.js';
import { getCurrentStepContext } from './current-step-context.js';

export interface WebSearchBackend {
  /** Run a search; the executor wraps the result in the canonical shape. */
  search(args: WebSearchArgs, ctx: ExecCtx): Promise<WebSearchResult>;
}

export interface WebFetchBackend {
  fetch(args: WebFetchArgs, ctx: ExecCtx): Promise<WebFetchResult>;
}

export interface WebToolBackends {
  search?: WebSearchBackend;
  fetch?: WebFetchBackend;
}

export interface WebToolExecutorOpts {
  /** Tool names the executor advertises; same shape as BuiltinToolExecutor. */
  allowedTools: Iterable<string>;
  backends?: WebToolBackends;
}

const SCHEMAS: Record<string, ToolSchema> = {
  web_search: {
    name: 'web_search',
    description:
      'Search the web for results matching `query`. Returns a list of (title, url, snippet) records. ' +
      'Read-only — no fetch / no auth. Use this when you need to find a URL; ' +
      'use web_fetch to read it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (≥2 chars).' },
        allowedDomains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns; if set, results must match one.',
        },
        blockedDomains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns; results matching any are dropped.',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 10, max 25).',
        },
      },
      required: ['query'],
    },
  },
  web_fetch: {
    name: 'web_fetch',
    description:
      'Fetch a URL and answer a focused question about its content. The page is ' +
      'fetched, HTML→Markdown converted, then a cheap-tier summarizer answers your ' +
      'prompt. You never see raw HTML — direct quotes are limited to 125 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL (≤2000 chars).' },
        prompt: { type: 'string', description: 'Focused question for the summarizer.' },
      },
      required: ['url', 'prompt'],
    },
  },
};

export class WebToolExecutor implements ToolExecutor {
  private readonly allowed: Set<string>;
  private readonly backends: WebToolBackends;

  constructor(opts: WebToolExecutorOpts) {
    this.allowed = new Set(opts.allowedTools);
    this.backends = opts.backends ?? {};
  }

  listSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      if (this.allowed.has(name)) out.push(schema);
    }
    return out;
  }

  async execute(call: ToolCall, ctx: ExecCtx): Promise<ToolResult> {
    if (!this.allowed.has(call.name)) {
      return { isError: true, content: `Tool "${call.name}" is not permitted in this stage.` };
    }
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (call.name) {
        case 'web_search': {
          const validated = validateSearchArgs(args);
          if (!this.backends.search) {
            return { isError: true, content: 'web_search backend not configured.' };
          }
          const result = await durableWrap(
            'web:search',
            shortHash(JSON.stringify(validated)),
            () => this.backends.search!.search(validated, ctx),
          );
          return { isError: false, content: formatSearchResult(result) };
        }
        case 'web_fetch': {
          const validated = validateFetchArgs(args);
          if (!this.backends.fetch) {
            return { isError: true, content: 'web_fetch backend not configured.' };
          }
          const result = await durableWrap(
            'web:fetch',
            shortHash(`${validated.url}\u241F${validated.prompt}`),
            () => this.backends.fetch!.fetch(validated, ctx),
          );
          return { isError: false, content: formatFetchResult(result) };
        }
        default:
          return { isError: true, content: `Unknown web tool "${call.name}".` };
      }
    } catch (err) {
      return { isError: true, content: errorMessage(err) };
    }
  }
}

/**
 * Wrap a tool call in `ctx.effect()` when a step context is registered
 * (Phase H3). When no context is active (e.g. ad-hoc CLI commands or
 * test paths), the function is invoked directly. Effect names follow
 * the §J convention from the browser-web-tools plan.
 */
async function durableWrap<T>(effectName: string, key: string, fn: () => Promise<T>): Promise<T> {
  const ctx = getCurrentStepContext();
  if (!ctx) return fn();
  return ctx.effect(`${effectName}:${key}`, fn, { idempotencyKey: key });
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ── Argument validation ─────────────────────────────────────────────────

function validateSearchArgs(args: Record<string, unknown>): WebSearchArgs {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length < 2) {
    throw new Error('web_search: query must be a string of at least 2 characters');
  }
  const allowedDomains = optionalStringArray(args.allowedDomains, 'allowedDomains');
  const blockedDomains = optionalStringArray(args.blockedDomains, 'blockedDomains');
  const limit = optionalInteger(args.limit, 'limit', 1, 25);
  return { query, allowedDomains, blockedDomains, limit };
}

function validateFetchArgs(args: Record<string, unknown>): WebFetchArgs {
  const url = args.url;
  if (typeof url !== 'string' || url.length === 0 || url.length > 2000) {
    throw new Error('web_fetch: url must be a non-empty string ≤ 2000 chars');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('web_fetch: url must use http:// or https:// scheme');
  }
  const prompt = args.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('web_fetch: prompt must be a non-empty string');
  }
  return { url, prompt };
}

function optionalStringArray(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${name} must be an array of strings`);
  for (const s of v) {
    if (typeof s !== 'string' || s.length === 0) {
      throw new Error(`${name} entries must be non-empty strings`);
    }
  }
  return v.slice();
}

function optionalInteger(v: unknown, name: string, lo: number, hi: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`${name} must be an integer`);
  }
  if (v < lo || v > hi) {
    throw new Error(`${name} must be in [${lo}, ${hi}]`);
  }
  return v;
}

// ── Result formatting (model-facing) ───────────────────────────────────

function formatSearchResult(r: WebSearchResult): string {
  const head = `Search results for "${r.query}" (${r.resultCount} hit${r.resultCount === 1 ? '' : 's'}):`;
  if (r.results.length === 0) return `${head}\n(no matches)`;
  const lines = r.results.map((hit, i) => {
    const snippet = hit.snippet ? ` — ${hit.snippet}` : '';
    return `${i + 1}. ${hit.title}\n   ${hit.url}${snippet}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

function formatFetchResult(r: WebFetchResult): string {
  const lines = [
    `URL: ${r.url}${r.finalUrl !== r.url ? ` → ${r.finalUrl}` : ''}`,
    `Fetched: ${r.fetchedAt}`,
    `Summarizer: ${r.summarizerModel}${r.ssr ? '' : ' (SPA — empty body)'}`,
  ];
  if (r.hint) lines.push(`Hint: ${r.hint}`);
  lines.push('', r.answer);
  return lines.join('\n');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
