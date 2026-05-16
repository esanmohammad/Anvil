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
import { type DomNode } from './dom-serializer.js';
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
    scroll: {
        x: number;
        y: number;
        pageHeight: number;
        viewportHeight: number;
    };
    tabs: Array<{
        tabId: string;
        title: string;
        url: string;
        active?: boolean;
    }>;
}
/**
 * Backend interface every browser runner implements (Playwright,
 * Stagehand, mock). Methods may resolve with `error` set instead of
 * throwing for recoverable conditions.
 */
export interface BrowserRunner {
    navigate(args: RunnerNavigateArgs): Promise<RunnerSnapshot>;
    click(args: {
        index: number;
    }): Promise<RunnerSnapshot>;
    input(args: {
        index: number;
        text: string;
        clear?: boolean;
    }): Promise<RunnerSnapshot>;
    scroll(args: {
        down?: boolean;
        pages?: number;
        index?: number;
    }): Promise<RunnerSnapshot>;
    snapshot(): Promise<RunnerSnapshot>;
    searchPage(args: {
        pattern: string;
        regex?: boolean;
        caseSensitive?: boolean;
        cssScope?: string;
        contextChars?: number;
        maxResults?: number;
    }): Promise<{
        hits: Array<{
            index: number;
            snippet: string;
            charOffset: number;
        }>;
    }>;
    screenshot(args: {
        fullPage?: boolean;
        selector?: string;
    }): Promise<{
        imageBase64: string;
        width: number;
        height: number;
    }>;
    evaluate(args: {
        expression: string;
    }): Promise<{
        result: unknown;
        resolved: boolean;
    }>;
    consoleMessages(args: {
        level?: string;
        cursor?: string;
        limit?: number;
    }): Promise<{
        messages: BrowserConsoleMessage[];
        nextCursor?: string;
    }>;
    networkRequests(args: {
        urlPattern?: string;
        status?: number;
        method?: string;
        failed?: boolean;
        cursor?: string;
        limit?: number;
    }): Promise<{
        requests: BrowserNetworkRecord[];
        nextCursor?: string;
    }>;
    newTab(args: {
        url?: string;
    }): Promise<RunnerSnapshot>;
    closeTab(args: {
        tabId: string;
    }): Promise<RunnerSnapshot>;
    tabs(): Promise<{
        tabs: Array<{
            tabId: string;
            title: string;
            url: string;
        }>;
    }>;
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
    /** Path to a Playwright `storageState.json` (cookies + localStorage)
     *  to load on context creation. Used by `browser_attach_context` so
     *  the session starts authenticated against a saved login. */
    storageStatePath?: string;
}
export declare class BrowserSession {
    readonly runId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly opts: BrowserSessionOpts;
    private runner;
    private effectIdx;
    private closed;
    private readonly factory;
    constructor(factory: BrowserRunnerFactory, opts: BrowserSessionOpts);
    isExpired(now?: number): boolean;
    /** Lazy-init the runner on first action. */
    private ensureRunner;
    nextEffectIdx(): number;
    navigate(args: RunnerNavigateArgs): Promise<BrowserState>;
    click(index: number): Promise<BrowserState>;
    input(index: number, text: string, clear?: boolean): Promise<BrowserState>;
    scroll(args: {
        down?: boolean;
        pages?: number;
        index?: number;
    }): Promise<BrowserState>;
    getRunner(): Promise<BrowserRunner>;
    close(): Promise<void>;
    private toState;
}
/**
 * Per-process browser session registry. Looks sessions up by
 * `(runId, sessionId)` so tool-call dispatchers can resume the right
 * browser across multiple agent steps.
 */
export declare class BrowserSessionRegistry {
    private readonly sessions;
    private readonly factory;
    constructor(factory: BrowserRunnerFactory);
    private keyFor;
    get(runId: string, sessionId: string): BrowserSession | undefined;
    acquire(opts: BrowserSessionOpts): BrowserSession;
    release(runId: string, sessionId: string): Promise<void>;
    /** Periodic cleanup — dashboard calls this from a setInterval. */
    sweepExpired(now?: number): Promise<number>;
}
//# sourceMappingURL=session-manager.d.ts.map