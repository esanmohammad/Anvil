/**
 * Type definitions for the browser/web tool surface.
 *
 * Three tiers:
 *   1. Tier 1 (`web.*`)      — search + fetch with cheap-tier summarizer
 *   2. Tier 2 (`browser.*`)  — Playwright-driven indexed-DOM browser
 *   3. Tier 3 (`computer.*`) — pixel-coordinate browser via provider native CUA
 *
 * Provider-agnostic: every model/summarizer call resolves through Anvil's
 * standard stage-routing (`resolveModelForStage('web-summarizer' | 'browser-extractor')`).
 */

export interface WebSearchArgs {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  limit?: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchResult {
  query: string;
  results: WebSearchHit[];
  resultCount: number;
}

export interface WebFetchArgs {
  url: string;
  prompt: string;
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  contentType: string;
  fetchedAt: string;
  /** Summarizer's answer — paraphrased, ≤125-char direct quotes. */
  answer: string;
  /** Model id used for the summarizer (audit). */
  summarizerModel: string;
  /** True if the page rendered substantive HTML (i.e. not an empty SPA shell). */
  ssr: boolean;
  hint?: string;
  /** Measured summarizer cost (USD) — flows into the durable event
   *  payload so the per-tool cost ledger shows real spend instead of
   *  the §I unit estimates. */
  costUsd?: number;
}

export interface BrowserNavigateArgs {
  url: string;
  newTab?: boolean;
  freshSession?: boolean;
  timeoutMs?: number;
}

export interface BrowserClickArgs {
  index: number;
}

export interface BrowserInputArgs {
  index: number;
  text: string;
  clear?: boolean;
}

export interface BrowserScrollArgs {
  down?: boolean;
  pages?: number;
  index?: number;
}

export interface BrowserSearchPageArgs {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  contextChars?: number;
  cssScope?: string;
  maxResults?: number;
}

export interface BrowserSearchPageResult {
  hits: Array<{ index: number; snippet: string; charOffset: number }>;
}

export interface BrowserExtractArgs {
  query: string;
  outputSchema?: object;
  extractLinks?: boolean;
  extractImages?: boolean;
  alreadyCollected?: string[];
  startFromChar?: number;
}

export interface BrowserExtractResult<T = unknown> {
  data: T;
  truncated: boolean;
}

export interface BrowserScreenshotArgs {
  fullPage?: boolean;
  selector?: string;
}

export interface BrowserScreenshotResult {
  imageBase64: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface BrowserEvaluateArgs {
  expression: string;
}

export interface BrowserEvaluateResult {
  result: unknown;
  resolved: boolean;
}

export interface BrowserConsoleArgs {
  level?: 'info' | 'warn' | 'error' | 'log' | 'debug';
  cursor?: string;
  limit?: number;
}

export interface BrowserConsoleMessage {
  ts: string;
  level: string;
  text: string;
  sourceUrl?: string;
}

export interface BrowserConsoleResult {
  messages: BrowserConsoleMessage[];
  nextCursor?: string;
}

export interface BrowserNetworkArgs {
  urlPattern?: string;
  status?: number;
  method?: string;
  failed?: boolean;
  cursor?: string;
  limit?: number;
}

export interface BrowserNetworkRecord {
  url: string;
  status: number;
  method: string;
  durationMs: number;
  ts: string;
  failed: boolean;
}

export interface BrowserNetworkResult {
  requests: BrowserNetworkRecord[];
  nextCursor?: string;
}

export interface BrowserTab {
  tabId: string;
  title: string;
  url: string;
  active?: boolean;
}

export interface BrowserDoneArgs {
  text: string;
  success?: boolean;
}

/** Returned from every Tier 2 action. Agent re-renders its prompt off this. */
export interface BrowserState {
  url: string;
  title: string;
  /** `[idx]<tag attrs>visible-text</tag>` per line. Capped at 40000 chars. */
  domText: string;
  /** Accessibility-tree text. Same cap. */
  axText: string;
  /** Optional viewport screenshot (base64 PNG) — gated by `attachScreenshot`. */
  screenshotBase64?: string;
  tabs: BrowserTab[];
  scroll: { x: number; y: number; pageHeight: number; viewportHeight: number };
  error?: { code: string; message: string };
  /** Stable across replays — the durable cursor. */
  effectIdx: number;
}

// ── Tier 3 — computer.* ──────────────────────────────────────────────

export type ComputerAction =
  | { action: 'screenshot' }
  | { action: 'click'; coordinate: [number, number]; button?: 'left' | 'middle' | 'right'; modifiers?: string[] }
  | { action: 'double_click'; coordinate: [number, number] }
  | { action: 'right_click'; coordinate: [number, number] }
  | { action: 'type'; text: string }
  | { action: 'key'; text: string }
  | { action: 'scroll'; coordinate: [number, number]; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { action: 'mouse_move'; coordinate: [number, number] }
  | { action: 'left_mouse_down'; coordinate: [number, number] }
  | { action: 'left_mouse_up'; coordinate: [number, number] }
  | { action: 'drag'; path: Array<[number, number]> }
  | { action: 'wait'; durationMs?: number };

export interface ComputerActionResult {
  /** PNG screenshot after the action. */
  imageBase64?: string;
  width?: number;
  height?: number;
  text?: string;
  error?: { code: string; message: string };
}

// ── Web/browser tool registry — extends ToolClass surface ──────────────

/**
 * Permission classes for the network/browser tool surface. These layer on
 * top of `ToolClass` (read|write|exec) — a stage that has both `read` and
 * `network` may invoke `read_file` AND `web.search`.
 */
export type WebToolClass =
  | 'network'        // web.* — Tier 1
  | 'browse-headless' // browser.* (excluding evaluate) — Tier 2
  | 'browse-eval'    // browser.evaluate — High-risk JS exec
  | 'browse-pixel';  // computer.* — Tier 3 vision-token

/**
 * Names of every tool in the web/browser surface, namespaced by tier.
 * The `BuiltinToolExecutor` filters by this set + `ToolClass` membership.
 */
export const WEB_TOOLS_BY_CLASS: Readonly<Record<WebToolClass, readonly string[]>> = {
  network: [
    'web_search',
    'web_fetch',
  ],
  'browse-headless': [
    'browser_navigate',
    'browser_click',
    'browser_input',
    'browser_scroll',
    'browser_search_page',
    'browser_extract',
    'browser_screenshot',
    'browser_console_messages',
    'browser_network_requests',
    'browser_new_tab',
    'browser_close_tab',
    'browser_tabs',
    'browser_done',
    'browser_attach_context',
  ],
  'browse-eval': [
    'browser_evaluate',
  ],
  'browse-pixel': [
    'computer_use',
  ],
};

export const ALL_WEB_TOOL_NAMES: readonly string[] = Object.values(WEB_TOOLS_BY_CLASS).flat();

export function webToolClassForName(name: string): WebToolClass | undefined {
  for (const [cls, names] of Object.entries(WEB_TOOLS_BY_CLASS) as Array<[WebToolClass, readonly string[]]>) {
    if (names.includes(name)) return cls;
  }
  return undefined;
}
