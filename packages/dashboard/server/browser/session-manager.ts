/**
 * Per-(runId, sessionId) browser session lifecycle. Kicks off
 * a Playwright child process via the supplied runner factory, tracks
 * timeout, returns the active session for tool-call handlers.
 *
 * The runner is dependency-injected so tests + dev environments without
 * Playwright installed can plug in a stub. Production wires
 * `createPlaywrightRunner` from playwright-runner.ts.
 */

import type { BrowserState, BrowserNetworkRecord, BrowserConsoleMessage } from '@esankhan3/anvil-core-pipeline';
import { serializeDom, type DomNode } from './dom-serializer.js';

export interface RunnerNavigateArgs {
  url: string;
  newTab?: boolean;
  timeoutMs?: number;
}

export interface RunnerSnapshot {
  url: string;
  title: string;
  domRoot: DomNode;
  axText?: string;
  scroll: { x: number; y: number; pageHeight: number; viewportHeight: number };
  tabs: Array<{ tabId: string; title: string; url: string; active?: boolean }>;
}

/**
 * Backend interface every browser runner implements (Playwright,
 * Stagehand, mock). Methods may resolve with `error` set instead of
 * throwing for recoverable conditions.
 */
export interface BrowserRunner {
  navigate(args: RunnerNavigateArgs): Promise<RunnerSnapshot>;
  click(args: { index: number }): Promise<RunnerSnapshot>;
  input(args: { index: number; text: string; clear?: boolean }): Promise<RunnerSnapshot>;
  scroll(args: { down?: boolean; pages?: number; index?: number }): Promise<RunnerSnapshot>;
  snapshot(): Promise<RunnerSnapshot>;
  searchPage(args: { pattern: string; regex?: boolean; caseSensitive?: boolean; cssScope?: string }): Promise<{
    hits: Array<{ index: number; snippet: string; charOffset: number }>;
  }>;
  screenshot(args: { fullPage?: boolean; selector?: string }): Promise<{
    imageBase64: string; width: number; height: number;
  }>;
  evaluate(args: { expression: string }): Promise<{ result: unknown; resolved: boolean }>;
  consoleMessages(args: { level?: string; cursor?: string; limit?: number }): Promise<{
    messages: BrowserConsoleMessage[];
    nextCursor?: string;
  }>;
  networkRequests(args: { urlPattern?: string; status?: number; method?: string; failed?: boolean; cursor?: string; limit?: number }): Promise<{
    requests: BrowserNetworkRecord[];
    nextCursor?: string;
  }>;
  newTab(args: { url?: string }): Promise<RunnerSnapshot>;
  closeTab(args: { tabId: string }): Promise<RunnerSnapshot>;
  tabs(): Promise<{ tabs: Array<{ tabId: string; title: string; url: string }> }>;
  /** Stop and release resources. Idempotent. */
  close(): Promise<void>;
}

export type BrowserRunnerFactory = (opts: BrowserSessionOpts) => Promise<BrowserRunner>;

export interface BrowserSessionOpts {
  runId: string;
  sessionId: string;
  /** Per-session user-data directory. */
  userDataDir: string;
  /** When false, a fresh browser context (no cookies). Default true. */
  persistContext?: boolean;
  /** Headless toggle. Default true. */
  headless?: boolean;
  /** Soft session timeout in ms. Default 15 min. */
  timeoutMs?: number;
}

export class BrowserSession {
  readonly runId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly opts: BrowserSessionOpts;
  private runner: BrowserRunner | undefined;
  private effectIdx = 0;
  private closed = false;
  private readonly factory: BrowserRunnerFactory;

  constructor(factory: BrowserRunnerFactory, opts: BrowserSessionOpts) {
    this.factory = factory;
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
    this.opts = opts;
    this.startedAt = Date.now();
  }

  isExpired(now = Date.now()): boolean {
    const ttl = this.opts.timeoutMs ?? 15 * 60_000;
    return now - this.startedAt > ttl;
  }

  /** Lazy-init the runner on first action. */
  private async ensureRunner(): Promise<BrowserRunner> {
    if (this.closed) throw new Error('session-closed');
    if (this.isExpired()) throw Object.assign(new Error('session-expired'), { code: 'session-expired' });
    if (!this.runner) {
      this.runner = await this.factory(this.opts);
    }
    return this.runner;
  }

  nextEffectIdx(): number {
    return this.effectIdx++;
  }

  async navigate(args: RunnerNavigateArgs): Promise<BrowserState> {
    const runner = await this.ensureRunner();
    return this.toState(await runner.navigate(args));
  }

  async click(index: number): Promise<BrowserState> {
    const runner = await this.ensureRunner();
    return this.toState(await runner.click({ index }));
  }

  async input(index: number, text: string, clear?: boolean): Promise<BrowserState> {
    const runner = await this.ensureRunner();
    return this.toState(await runner.input({ index, text, clear }));
  }

  async scroll(args: { down?: boolean; pages?: number; index?: number }): Promise<BrowserState> {
    const runner = await this.ensureRunner();
    return this.toState(await runner.scroll(args));
  }

  async getRunner(): Promise<BrowserRunner> {
    return this.ensureRunner();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.runner) {
      try { await this.runner.close(); } catch { /* swallow */ }
    }
  }

  private toState(snap: RunnerSnapshot): BrowserState {
    const ser = serializeDom(snap.domRoot);
    return {
      url: snap.url,
      title: snap.title,
      domText: ser.domText,
      axText: snap.axText ?? '',
      tabs: snap.tabs,
      scroll: snap.scroll,
      effectIdx: this.effectIdx,
    };
  }
}

/**
 * Per-process browser session registry. Looks sessions up by
 * `(runId, sessionId)` so tool-call dispatchers can resume the right
 * browser across multiple agent steps.
 */
export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly factory: BrowserRunnerFactory;

  constructor(factory: BrowserRunnerFactory) {
    this.factory = factory;
  }

  private keyFor(runId: string, sessionId: string): string {
    return `${runId}\u241F${sessionId}`;
  }

  get(runId: string, sessionId: string): BrowserSession | undefined {
    const k = this.keyFor(runId, sessionId);
    const s = this.sessions.get(k);
    if (!s) return undefined;
    if (s.isExpired()) {
      void s.close();
      this.sessions.delete(k);
      return undefined;
    }
    return s;
  }

  acquire(opts: BrowserSessionOpts): BrowserSession {
    const k = this.keyFor(opts.runId, opts.sessionId);
    const existing = this.sessions.get(k);
    if (existing && !existing.isExpired()) return existing;
    if (existing) void existing.close();
    const session = new BrowserSession(this.factory, opts);
    this.sessions.set(k, session);
    return session;
  }

  async release(runId: string, sessionId: string): Promise<void> {
    const k = this.keyFor(runId, sessionId);
    const s = this.sessions.get(k);
    if (s) {
      await s.close();
      this.sessions.delete(k);
    }
  }

  /** Periodic cleanup — dashboard calls this from a setInterval. */
  async sweepExpired(now = Date.now()): Promise<number> {
    let cleaned = 0;
    for (const [k, s] of this.sessions.entries()) {
      if (s.isExpired(now)) {
        await s.close();
        this.sessions.delete(k);
        cleaned += 1;
      }
    }
    return cleaned;
  }
}
