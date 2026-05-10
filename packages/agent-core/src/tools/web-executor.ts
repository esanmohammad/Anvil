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
  BrowserNavigateArgs,
  BrowserClickArgs,
  BrowserInputArgs,
  BrowserScrollArgs,
  BrowserState,
  BrowserDoneArgs,
  BrowserScreenshotArgs,
  BrowserScreenshotResult,
  BrowserConsoleArgs,
  BrowserConsoleResult,
  BrowserNetworkArgs,
  BrowserNetworkResult,
  BrowserSearchPageArgs,
  BrowserSearchPageResult,
  BrowserExtractArgs,
  BrowserExtractResult,
  BrowserEvaluateArgs,
  BrowserEvaluateResult,
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

export interface BrowserBackend {
  navigate(args: BrowserNavigateArgs, ctx: ExecCtx): Promise<BrowserState>;
  click(args: BrowserClickArgs, ctx: ExecCtx): Promise<BrowserState>;
  input(args: BrowserInputArgs, ctx: ExecCtx): Promise<BrowserState>;
  scroll(args: BrowserScrollArgs, ctx: ExecCtx): Promise<BrowserState>;
  done(args: BrowserDoneArgs, ctx: ExecCtx): Promise<void>;
  searchPage?(args: BrowserSearchPageArgs, ctx: ExecCtx): Promise<BrowserSearchPageResult>;
  extract?(args: BrowserExtractArgs, ctx: ExecCtx): Promise<BrowserExtractResult>;
  screenshot?(args: BrowserScreenshotArgs, ctx: ExecCtx): Promise<BrowserScreenshotResult>;
  consoleMessages?(args: BrowserConsoleArgs, ctx: ExecCtx): Promise<BrowserConsoleResult>;
  networkRequests?(args: BrowserNetworkArgs, ctx: ExecCtx): Promise<BrowserNetworkResult>;
  evaluate?(args: BrowserEvaluateArgs, ctx: ExecCtx): Promise<BrowserEvaluateResult>;
  newTab?(args: { url?: string }, ctx: ExecCtx): Promise<BrowserState>;
  closeTab?(args: { tabId: string }, ctx: ExecCtx): Promise<BrowserState>;
  tabs?(ctx: ExecCtx): Promise<{ tabs: Array<{ tabId: string; title: string; url: string }> }>;
  attachContext?(args: { name: string }, ctx: ExecCtx): Promise<BrowserState>;
}

export interface ComputerUseBackend {
  /** Execute a single canonical action; returns post-action screenshot. */
  do(action: unknown, ctx: ExecCtx): Promise<{
    imageBase64?: string;
    width?: number;
    height?: number;
    text?: string;
    error?: { code: string; message: string };
  }>;
}

export interface WebToolBackends {
  search?: WebSearchBackend;
  fetch?: WebFetchBackend;
  browser?: BrowserBackend;
  computer?: ComputerUseBackend;
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
  browser_navigate: {
    name: 'browser_navigate',
    description:
      'Open a URL in the headless browser. Reuses the existing session by default ' +
      '(cookies persist within the run). Returns the indexed-DOM snapshot — each ' +
      'interactive element gets a stable index you can pass to browser_click.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        newTab: { type: 'boolean' },
        freshSession: { type: 'boolean' },
        timeoutMs: { type: 'integer', description: 'Soft load timeout (default 30 000)' },
      },
      required: ['url'],
    },
  },
  browser_click: {
    name: 'browser_click',
    description:
      'Click the element at the given DOM index (assigned by the snapshot serializer). ' +
      'If the page changed, re-fetch the snapshot via browser_navigate or another action.',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
  },
  browser_input: {
    name: 'browser_input',
    description: 'Type into the element at `index`. Clears existing value by default.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
      },
      required: ['index', 'text'],
    },
  },
  browser_scroll: {
    name: 'browser_scroll',
    description: 'Scroll the page. `pages: 0.5` = half a viewport; default 1.0 down.',
    inputSchema: {
      type: 'object',
      properties: {
        down: { type: 'boolean' },
        pages: { type: 'number' },
        index: { type: 'integer' },
      },
    },
  },
  browser_done: {
    name: 'browser_done',
    description: 'End the browser session and report back. Required at the end of every browser interaction.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Summary of what you did / found.' },
        success: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  browser_screenshot: {
    name: 'browser_screenshot',
    description: 'Capture a viewport screenshot. Returns base64 PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean' },
        selector: { type: 'string' },
      },
    },
  },
  browser_search_page: {
    name: 'browser_search_page',
    description: 'Find text on the current page. Returns line snippets + char offsets.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        contextChars: { type: 'integer' },
        cssScope: { type: 'string' },
        maxResults: { type: 'integer' },
      },
      required: ['pattern'],
    },
  },
  browser_extract: {
    name: 'browser_extract',
    description: 'Extract structured data from the current page via a separate extractor agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        outputSchema: { type: 'object' },
        extractLinks: { type: 'boolean' },
        extractImages: { type: 'boolean' },
        alreadyCollected: { type: 'array', items: { type: 'string' } },
        startFromChar: { type: 'integer' },
      },
      required: ['query'],
    },
  },
  browser_console_messages: {
    name: 'browser_console_messages',
    description: 'Read recent console messages. Bounded ring buffer; cursor for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warn', 'error', 'log', 'debug'] },
        cursor: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  browser_network_requests: {
    name: 'browser_network_requests',
    description: 'Inspect XHR/fetch/document requests. Filterable by url/status/method/failed.',
    inputSchema: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string' },
        status: { type: 'integer' },
        method: { type: 'string' },
        failed: { type: 'boolean' },
        cursor: { type: 'string' },
        limit: { type: 'integer' },
      },
    },
  },
  browser_new_tab: {
    name: 'browser_new_tab',
    description: 'Open a new tab; optionally navigate to `url`.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
    },
  },
  browser_close_tab: {
    name: 'browser_close_tab',
    description: 'Close the tab with the given tabId.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
    },
  },
  browser_tabs: {
    name: 'browser_tabs',
    description: 'List all open tabs.',
    inputSchema: { type: 'object', properties: {} },
  },
  browser_evaluate: {
    name: 'browser_evaluate',
    description: 'Evaluate a JS expression in the page context. Sandbox-restricted; gated by user-confirm.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
  browser_attach_context: {
    name: 'browser_attach_context',
    description: 'Switch to a saved auth context (e.g. logged-in docs portal).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  computer_use: {
    name: 'computer_use',
    description:
      'Tier 3 pixel-coordinate browser. Emit a canonical action (click/type/scroll/etc.); ' +
      'returns the post-action screenshot. Available only on vision-capable models with ' +
      'computer-use support (Claude 4.5+, GPT-4o CUA, Gemini 2.5 Computer Use). ' +
      'GATED: every action requires user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'screenshot | click | double_click | right_click | type | key | scroll | mouse_move | drag | wait' },
        coordinate: { type: 'array', items: { type: 'number' } },
        text: { type: 'string' },
        button: { type: 'string', enum: ['left', 'middle', 'right'] },
        modifiers: { type: 'array', items: { type: 'string' } },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number' },
        path: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        durationMs: { type: 'number' },
      },
      required: ['action'],
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
        case 'browser_navigate':
        case 'browser_click':
        case 'browser_input':
        case 'browser_scroll':
        case 'browser_done':
        case 'browser_screenshot':
        case 'browser_search_page':
        case 'browser_extract':
        case 'browser_console_messages':
        case 'browser_network_requests':
        case 'browser_new_tab':
        case 'browser_close_tab':
        case 'browser_tabs':
        case 'browser_evaluate':
        case 'browser_attach_context':
          return this.dispatchBrowser(call.name, args, ctx);
        case 'computer_use': {
          if (!this.backends.computer) {
            return { isError: true, content: 'computer_use: backend not configured. Tier 3 requires Docker + a vision-capable model.' };
          }
          const result = await durableWrap(
            'computer:action',
            shortHash(JSON.stringify(args)),
            () => this.backends.computer!.do(args, ctx),
          );
          if (result.error) return { isError: true, content: `${result.error.code}: ${result.error.message}` };
          return { isError: false, content: `[computer ${String(args.action)} ${result.width ?? '?'}×${result.height ?? '?'}] ${result.text ?? ''}` };
        }
        default:
          return { isError: true, content: `Unknown web tool "${call.name}".` };
      }
    } catch (err) {
      return { isError: true, content: errorMessage(err) };
    }
  }

  private async dispatchBrowser(
    name: string,
    args: Record<string, unknown>,
    ctx: ExecCtx,
  ): Promise<ToolResult> {
    const browser = this.backends.browser;
    if (!browser) {
      return { isError: true, content: `${name}: browser backend not configured. Tier-2 tools require Playwright.` };
    }
    try {
      switch (name) {
        case 'browser_navigate': {
          const validated = validateNavigateArgs(args);
          const state = await durableWrap(
            'browser:navigate',
            shortHash(validated.url),
            () => browser.navigate(validated, ctx),
          );
          return { isError: false, content: formatBrowserState(state) };
        }
        case 'browser_click': {
          const idx = requireInteger(args.index, 'index');
          const state = await durableWrap('browser:click', String(idx), () => browser.click({ index: idx }, ctx));
          return { isError: false, content: formatBrowserState(state) };
        }
        case 'browser_input': {
          const idx = requireInteger(args.index, 'index');
          const text = requireString(args.text, 'text', { allowEmpty: true });
          const clear = optionalBoolean(args.clear);
          const state = await browser.input({ index: idx, text, clear }, ctx);
          return { isError: false, content: formatBrowserState(state) };
        }
        case 'browser_scroll': {
          const down = optionalBoolean(args.down);
          const pages = optionalNumber(args.pages, 'pages');
          const idx = optionalInteger(args.index, 'index', 0, 1_000_000);
          const state = await browser.scroll({ down, pages, index: idx }, ctx);
          return { isError: false, content: formatBrowserState(state) };
        }
        case 'browser_done': {
          const text = requireString(args.text, 'text');
          const success = optionalBoolean(args.success);
          await browser.done({ text, success }, ctx);
          return { isError: false, content: `Browser session ended.${success === false ? ' (success: false)' : ''}\n${text}` };
        }
        case 'browser_screenshot': {
          if (!browser.screenshot) return { isError: true, content: 'browser_screenshot not implemented by this backend.' };
          const result = await durableWrap('browser:screenshot', String(Date.now()), () => browser.screenshot!({
            fullPage: optionalBoolean(args.fullPage),
            selector: optionalString(args.selector, 'selector'),
          }, ctx));
          return { isError: false, content: `[screenshot ${result.width}×${result.height}, base64 length ${result.imageBase64.length}]` };
        }
        case 'browser_search_page': {
          if (!browser.searchPage) return { isError: true, content: 'browser_search_page not implemented.' };
          const r = await browser.searchPage({
            pattern: requireString(args.pattern, 'pattern'),
            regex: optionalBoolean(args.regex),
            caseSensitive: optionalBoolean(args.caseSensitive),
            cssScope: optionalString(args.cssScope, 'cssScope'),
            contextChars: optionalInteger(args.contextChars, 'contextChars', 0, 4_000),
            maxResults: optionalInteger(args.maxResults, 'maxResults', 1, 200),
          }, ctx);
          return { isError: false, content: r.hits.map((h) => `[${h.index}] ${h.snippet} (offset ${h.charOffset})`).join('\n') || '(no matches)' };
        }
        case 'browser_extract': {
          if (!browser.extract) return { isError: true, content: 'browser_extract not implemented.' };
          const r = await durableWrap('browser:extract', shortHash(JSON.stringify(args)), () => browser.extract!({
            query: requireString(args.query, 'query'),
            outputSchema: args.outputSchema as object | undefined,
            extractLinks: optionalBoolean(args.extractLinks),
            extractImages: optionalBoolean(args.extractImages),
            alreadyCollected: optionalStringArray(args.alreadyCollected, 'alreadyCollected'),
            startFromChar: optionalInteger(args.startFromChar, 'startFromChar', 0, 1_000_000),
          }, ctx));
          return { isError: false, content: JSON.stringify(r.data) + (r.truncated ? '\n[truncated]' : '') };
        }
        case 'browser_console_messages': {
          if (!browser.consoleMessages) return { isError: true, content: 'browser_console_messages not implemented.' };
          const r = await browser.consoleMessages({
            level: optionalEnum(args.level, ['info', 'warn', 'error', 'log', 'debug']),
            cursor: optionalString(args.cursor, 'cursor'),
            limit: optionalInteger(args.limit, 'limit', 1, 1_000),
          }, ctx);
          const lines = r.messages.map((m) => `${m.ts} ${m.level} ${m.text}`);
          return { isError: false, content: lines.join('\n') || '(no messages)' };
        }
        case 'browser_network_requests': {
          if (!browser.networkRequests) return { isError: true, content: 'browser_network_requests not implemented.' };
          const r = await browser.networkRequests({
            urlPattern: optionalString(args.urlPattern, 'urlPattern'),
            status: optionalInteger(args.status, 'status', 100, 599),
            method: optionalString(args.method, 'method'),
            failed: optionalBoolean(args.failed),
            cursor: optionalString(args.cursor, 'cursor'),
            limit: optionalInteger(args.limit, 'limit', 1, 500),
          }, ctx);
          const lines = r.requests.map((req) => `${req.method} ${req.status} ${req.url} (${req.durationMs}ms)`);
          return { isError: false, content: lines.join('\n') || '(no requests)' };
        }
        case 'browser_evaluate': {
          if (!browser.evaluate) return { isError: true, content: 'browser_evaluate not implemented.' };
          const r = await durableWrap('browser:evaluate', shortHash(String(args.expression)), () =>
            browser.evaluate!({ expression: requireString(args.expression, 'expression') }, ctx),
          );
          return { isError: !r.resolved, content: JSON.stringify(r.result) };
        }
        case 'browser_new_tab': {
          if (!browser.newTab) return { isError: true, content: 'browser_new_tab not implemented.' };
          const state = await browser.newTab({ url: optionalString(args.url, 'url') }, ctx);
          return { isError: false, content: formatBrowserState(state) };
        }
        case 'browser_close_tab': {
          if (!browser.closeTab) return { isError: true, content: 'browser_close_tab not implemented.' };
          const state = await browser.closeTab({ tabId: requireString(args.tabId, 'tabId') }, ctx);
          return { isError: false, content: formatBrowserState(state) };
        }
        case 'browser_tabs': {
          if (!browser.tabs) return { isError: true, content: 'browser_tabs not implemented.' };
          const r = await browser.tabs(ctx);
          return { isError: false, content: r.tabs.map((t) => `${t.tabId}: ${t.title} (${t.url})`).join('\n') };
        }
        case 'browser_attach_context': {
          if (!browser.attachContext) return { isError: true, content: 'browser_attach_context not implemented.' };
          const state = await browser.attachContext({ name: requireString(args.name, 'name') }, ctx);
          return { isError: false, content: formatBrowserState(state) };
        }
        default:
          return { isError: true, content: `Unhandled browser tool "${name}".` };
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

// ── Tier-2 argument validators + formatters ───────────────────────────

function validateNavigateArgs(args: Record<string, unknown>): BrowserNavigateArgs {
  const url = args.url;
  if (typeof url !== 'string' || url.length === 0 || url.length > 2000) {
    throw new Error('browser_navigate: url must be a non-empty string ≤ 2000 chars');
  }
  return {
    url,
    newTab: optionalBoolean(args.newTab),
    freshSession: optionalBoolean(args.freshSession),
    timeoutMs: optionalInteger(args.timeoutMs, 'timeoutMs', 1, 600_000),
  };
}

function requireString(v: unknown, name: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  if (!opts.allowEmpty && v.length === 0) throw new Error(`${name} must not be empty`);
  return v;
}

function requireInteger(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${name} must be an integer`);
  return v;
}

function optionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return requireString(v, name);
}

function optionalBoolean(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error('expected boolean');
  return v;
}

function optionalNumber(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw new Error(`${name} must be a number`);
  return v;
}

function optionalEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new Error(`expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function formatBrowserState(state: BrowserState): string {
  const head = `URL: ${state.url}\nTitle: ${state.title}\nScroll: ${state.scroll.y}/${state.scroll.pageHeight}, viewport ${state.scroll.viewportHeight}\n`;
  const tabs = state.tabs.length > 1
    ? `\nTabs:\n${state.tabs.map((t) => `  ${t.tabId}: ${t.title}`).join('\n')}\n`
    : '';
  const error = state.error ? `\n[ERROR ${state.error.code}] ${state.error.message}\n` : '';
  return `${head}${tabs}${error}\nDOM:\n${state.domText}`;
}
