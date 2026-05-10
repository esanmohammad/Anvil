/**
 * Playwright-driven browser runner. Used in production. The `playwright`
 * package is dynamically imported so installations without it (CI fast
 * lane, lightweight dev shells) still load this module — `createPlaywrightRunner`
 * just rejects with a clear error.
 *
 * For now we expose a minimal subset (navigate/click/input/scroll/snapshot
 * + close). Extract/screenshot/console/network land in Phase H5.
 */

import type { BrowserRunner, BrowserSessionOpts, RunnerNavigateArgs, RunnerSnapshot } from './session-manager.js';
import type { DomNode } from './dom-serializer.js';
import { ConsoleRecorder, NetworkRecorder } from './network-recorder.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlaywrightLike = any;

export async function createPlaywrightRunner(opts: BrowserSessionOpts): Promise<BrowserRunner> {
  let playwright: PlaywrightLike;
  try {
    // The `'playwright'` module is an optional install. Resolve the
    // import via Function constructor so tsc doesn't try to type-check
    // the missing package.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<PlaywrightLike>;
    playwright = await dynamicImport('playwright');
  } catch (_err) {
    void _err;
    throw new Error(
      'playwright is not installed. Run `npm install -w @anvil-dev/dashboard playwright` ' +
      'and `npx playwright install chromium` to enable Tier-2 browser tools.',
    );
  }

  const browser = await playwright.chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({
    userAgent: 'Anvil/1.0 (Tier-2 browser)',
    // H10-followup #1 — load a saved auth context if one is wired
    // (browser_attach_context flow). Falls through to a fresh context
    // when undefined.
    storageState: opts.storageStatePath,
  });
  const page = await context.newPage();
  let nextElementId = 0;
  // Keep handle locator map across calls so click(index) hits the same element.
  const indexMap = new Map<number, string>(); // index → CSS selector

  // Console + network ring buffers — H5.
  const consoleRecorder = new ConsoleRecorder();
  const networkRecorder = new NetworkRecorder();

  page.on('console', (msg: PlaywrightLike) => {
    consoleRecorder.record({
      ts: new Date().toISOString(),
      level: String(msg.type?.() ?? 'log'),
      text: String(msg.text?.() ?? ''),
      sourceUrl: msg.location?.()?.url,
    });
  });

  // Track in-flight starts so we can compute durationMs on response.
  const requestStarts = new WeakMap<PlaywrightLike, number>();
  page.on('request', (req: PlaywrightLike) => {
    requestStarts.set(req, Date.now());
  });
  page.on('response', (res: PlaywrightLike) => {
    const req = res.request?.();
    const start = req ? requestStarts.get(req) : undefined;
    networkRecorder.record({
      url: String(res.url?.() ?? ''),
      status: Number(res.status?.() ?? 0),
      method: String(req?.method?.() ?? 'GET'),
      durationMs: start ? Date.now() - start : 0,
      ts: new Date().toISOString(),
      failed: false,
    });
  });
  page.on('requestfailed', (req: PlaywrightLike) => {
    const start = requestStarts.get(req);
    networkRecorder.record({
      url: String(req.url?.() ?? ''),
      status: 0,
      method: String(req.method?.() ?? 'GET'),
      durationMs: start ? Date.now() - start : 0,
      ts: new Date().toISOString(),
      failed: true,
    });
  });

  const snapshot = async (): Promise<RunnerSnapshot> => {
    indexMap.clear();
    nextElementId = 0;

    const data = await page.evaluate(() => {
      const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);
      const stripTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeOf = (el: Element): any => {
        if (stripTags.has(el.tagName)) return null;
        const attrs: Record<string, string> = {};
        for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
        const text = (el.textContent ?? '').slice(0, 400);
        const interactive = interactiveTags.has(el.tagName);
        // Capture a stable selector for re-locating during click.
        const id = el.id ? `#${el.id}` : '';
        const dataAttr = (el.getAttribute('data-anvil-idx') ? `[data-anvil-idx="${el.getAttribute('data-anvil-idx')}"]` : '');
        return {
          tag: el.tagName.toLowerCase(),
          attrs,
          text: el.children.length === 0 ? text : undefined,
          children: Array.from(el.children).map((c) => nodeOf(c)).filter(Boolean),
          interactive,
          _selector: id || dataAttr || el.tagName.toLowerCase(),
        };
      };
      return {
        url: window.location.href,
        title: document.title,
        scroll: { x: window.scrollX, y: window.scrollY, pageHeight: document.body.scrollHeight, viewportHeight: window.innerHeight },
        root: nodeOf(document.body),
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (n: any): DomNode => {
      if (n.interactive) {
        indexMap.set(nextElementId, n._selector);
        nextElementId += 1;
      }
      return {
        tag: n.tag,
        attrs: n.attrs,
        text: n.text,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: (n.children ?? []).map((c: any) => walk(c)),
        interactive: n.interactive,
      };
    };

    return {
      url: data.url,
      title: data.title,
      domRoot: walk(data.root),
      axText: '',
      scroll: data.scroll,
      tabs: [{ tabId: 'main', title: data.title, url: data.url, active: true }],
    };
  };

  const navigate = async (args: RunnerNavigateArgs): Promise<RunnerSnapshot> => {
    await page.goto(args.url, { timeout: args.timeoutMs ?? 30_000, waitUntil: 'load' });
    return snapshot();
  };

  const click = async ({ index }: { index: number }): Promise<RunnerSnapshot> => {
    const sel = indexMap.get(index);
    if (!sel) {
      const snap = await snapshot();
      return { ...snap, url: snap.url };
    }
    await page.click(sel);
    return snapshot();
  };

  const input = async ({ index, text, clear }: { index: number; text: string; clear?: boolean }): Promise<RunnerSnapshot> => {
    const sel = indexMap.get(index);
    if (!sel) return snapshot();
    if (clear !== false) await page.fill(sel, '');
    await page.type(sel, text);
    return snapshot();
  };

  const scroll = async ({ down, pages }: { down?: boolean; pages?: number }): Promise<RunnerSnapshot> => {
    const direction = (down ?? true) ? 1 : -1;
    const amount = (pages ?? 1) * 600;
    await page.evaluate(({ d, a }: { d: number; a: number }) => window.scrollBy(0, d * a), { d: direction, a: amount });
    return snapshot();
  };

  return {
    navigate, click, input, scroll, snapshot,
    async searchPage({ pattern, regex, caseSensitive, contextChars = 150, maxResults = 25 }): Promise<{ hits: Array<{ index: number; snippet: string; charOffset: number }> }> {
      const text = await page.evaluate(() => document.body.innerText ?? '');
      const flags = caseSensitive ? 'g' : 'gi';
      const re = regex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      const hits: Array<{ index: number; snippet: string; charOffset: number }> = [];
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = re.exec(text)) !== null && hits.length < maxResults) {
        const start = Math.max(0, m.index - contextChars);
        const end = Math.min(text.length, m.index + m[0].length + contextChars);
        hits.push({ index: i, snippet: text.slice(start, end), charOffset: m.index });
        i += 1;
      }
      return { hits };
    },
    async screenshot(): Promise<{ imageBase64: string; width: number; height: number }> {
      const buf = await page.screenshot({ fullPage: false });
      const vp = page.viewportSize() ?? { width: 1280, height: 720 };
      return { imageBase64: buf.toString('base64'), width: vp.width, height: vp.height };
    },
    async evaluate({ expression }): Promise<{ result: unknown; resolved: boolean }> {
      try {
        const result = await page.evaluate(expression);
        return { result, resolved: true };
      } catch (err) {
        return { result: err instanceof Error ? err.message : String(err), resolved: false };
      }
    },
    async consoleMessages(args) {
      return consoleRecorder.query(args);
    },
    async networkRequests(args) {
      return networkRecorder.query(args);
    },
    async newTab(): Promise<RunnerSnapshot> {
      return snapshot();
    },
    async closeTab(): Promise<RunnerSnapshot> {
      return snapshot();
    },
    async tabs(): Promise<{ tabs: Array<{ tabId: string; title: string; url: string }> }> {
      const snap = await snapshot();
      return { tabs: snap.tabs.map((t) => ({ tabId: t.tabId, title: t.title, url: t.url })) };
    },
    async close(): Promise<void> {
      try { await context.close(); } catch { /* swallow */ }
      try { await browser.close(); } catch { /* swallow */ }
    },
  };
}
