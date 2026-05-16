/**
 * Per-(runId, sessionId) browser session lifecycle. Kicks off
 * a Playwright child process via the supplied runner factory, tracks
 * timeout, returns the active session for tool-call handlers.
 *
 * The runner is dependency-injected so tests + dev environments without
 * Playwright installed can plug in a stub. Production wires
 * `createPlaywrightRunner` from playwright-runner.ts.
 */
import { serializeDom } from './dom-serializer.js';
export class BrowserSession {
    runId;
    sessionId;
    startedAt;
    opts;
    runner;
    effectIdx = 0;
    closed = false;
    factory;
    constructor(factory, opts) {
        this.factory = factory;
        this.runId = opts.runId;
        this.sessionId = opts.sessionId;
        this.opts = opts;
        this.startedAt = Date.now();
    }
    isExpired(now = Date.now()) {
        const ttl = this.opts.timeoutMs ?? 15 * 60_000;
        return now - this.startedAt > ttl;
    }
    /** Lazy-init the runner on first action. */
    async ensureRunner() {
        if (this.closed)
            throw new Error('session-closed');
        if (this.isExpired())
            throw Object.assign(new Error('session-expired'), { code: 'session-expired' });
        if (!this.runner) {
            this.runner = await this.factory(this.opts);
        }
        return this.runner;
    }
    nextEffectIdx() {
        return this.effectIdx++;
    }
    async navigate(args) {
        const runner = await this.ensureRunner();
        return this.toState(await runner.navigate(args));
    }
    async click(index) {
        const runner = await this.ensureRunner();
        return this.toState(await runner.click({ index }));
    }
    async input(index, text, clear) {
        const runner = await this.ensureRunner();
        return this.toState(await runner.input({ index, text, clear }));
    }
    async scroll(args) {
        const runner = await this.ensureRunner();
        return this.toState(await runner.scroll(args));
    }
    async getRunner() {
        return this.ensureRunner();
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.runner) {
            try {
                await this.runner.close();
            }
            catch { /* swallow */ }
        }
    }
    toState(snap) {
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
    sessions = new Map();
    factory;
    constructor(factory) {
        this.factory = factory;
    }
    keyFor(runId, sessionId) {
        return `${runId}\u241F${sessionId}`;
    }
    get(runId, sessionId) {
        const k = this.keyFor(runId, sessionId);
        const s = this.sessions.get(k);
        if (!s)
            return undefined;
        if (s.isExpired()) {
            void s.close();
            this.sessions.delete(k);
            return undefined;
        }
        return s;
    }
    acquire(opts) {
        const k = this.keyFor(opts.runId, opts.sessionId);
        const existing = this.sessions.get(k);
        if (existing && !existing.isExpired())
            return existing;
        if (existing)
            void existing.close();
        const session = new BrowserSession(this.factory, opts);
        this.sessions.set(k, session);
        return session;
    }
    async release(runId, sessionId) {
        const k = this.keyFor(runId, sessionId);
        const s = this.sessions.get(k);
        if (s) {
            await s.close();
            this.sessions.delete(k);
        }
    }
    /** Periodic cleanup — dashboard calls this from a setInterval. */
    async sweepExpired(now = Date.now()) {
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
//# sourceMappingURL=session-manager.js.map