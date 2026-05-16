/**
 * PR URL hook — scans artifact / agent text content for GitHub PR URLs
 * and forwards each unique match to a caller-supplied callback.
 *
 * Auto-subscribes to `artifact:emitted` (payload.data is scanned if it's
 * a string or has a string `text` field). For agent transport that
 * doesn't flow through the pipeline event bus today (e.g., the
 * dashboard's WS-broadcast `tool_result` chunks), call `handle.scanText`
 * directly with the raw text — same dedupe.
 *
 * Default regex matches `https://github.com/<owner>/<repo>/pull/<n>`.
 * Override by passing `regex` if you need to broaden coverage (gitlab,
 * etc.).
 */

import type { EventBus, EventListener } from '../types.js';

const DEFAULT_PR_URL_REGEX = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

export interface PrUrlHookOptions {
  /** Called once per unique PR URL (after dedupe). */
  onPrFound: (url: string) => void;
  /** Override the regex; default matches GitHub PRs. Must be /g. */
  regex?: RegExp;
  /** Override priority. Default 20. */
  priority?: number;
}

export interface PrUrlHookHandle {
  unsubscribe: () => void;
  /** Manually feed text — useful for transports that don't go through the bus. */
  scanText: (text: string) => void;
  /** Snapshot of the URLs seen so far. */
  readonly urls: ReadonlySet<string>;
}

export function attachPrUrlHook(
  bus: EventBus,
  opts: PrUrlHookOptions,
): PrUrlHookHandle {
  const regex = opts.regex ?? DEFAULT_PR_URL_REGEX;
  if (!regex.global) {
    throw new Error('attachPrUrlHook: regex must be global (/g)');
  }
  const priority = opts.priority ?? 20;
  const seen = new Set<string>();

  const scan = (text: string): void => {
    if (!text) return;
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (!matches) return;
    for (const url of matches) {
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        opts.onPrFound(url);
      } catch {
        // swallow — caller bug shouldn't break the bus listener
      }
    }
  };

  const listener: EventListener = (event) => {
    if (event.hook !== 'artifact:emitted') return;
    const data = (event.payload as { data?: unknown } | undefined)?.data;
    if (typeof data === 'string') {
      scan(data);
      return;
    }
    if (data && typeof data === 'object') {
      // Common shapes: { text: string }, { content: string }, ...
      const maybeText = (data as { text?: unknown; content?: unknown }).text
        ?? (data as { text?: unknown; content?: unknown }).content;
      if (typeof maybeText === 'string') scan(maybeText);
    }
  };

  const off = bus.on('artifact:emitted', listener, { priority });

  return {
    unsubscribe: off,
    scanText: scan,
    get urls() { return seen; },
  };
}

export const PR_URL_REGEX = DEFAULT_PR_URL_REGEX;
