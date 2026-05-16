/**
 * No-progress detector — fires when the agent takes N actions in a row
 * without changing `(url, viewportHash, lastInteractionType)`. Prevents
 * the agent from looping on the same dead-end page.
 *
 * The harness emits `__anvilBrowseStalled` to the agent when the
 * threshold is hit; the agent's prompt instructs it to call
 * `browser.done` in response.
 */
const DEFAULT_THRESHOLD = 3;
export class NoProgressDetector {
    threshold;
    last;
    streak = 0;
    constructor(opts = {}) {
        this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    }
    /** Returns true when the action stalled the loop and should be reported. */
    observe(t) {
        if (this.last && t.url === this.last.url
            && t.viewportHash === this.last.viewportHash
            && t.lastInteractionType === this.last.lastInteractionType) {
            this.streak += 1;
        }
        else {
            this.streak = 1;
        }
        this.last = t;
        return { stalled: this.streak >= this.threshold, streak: this.streak };
    }
    reset() {
        this.last = undefined;
        this.streak = 0;
    }
}
/**
 * Per-session rate limiter for screenshot / click actions. Prevents
 * vision-token griefing + tool-spam on the same session.
 *
 *   click       → 1 / sec
 *   screenshot  → 6 / minute (~1 every 10s)
 */
export class RateLimiter {
    windowMs;
    maxInWindow;
    events = [];
    constructor(maxInWindow, windowMs) {
        this.maxInWindow = maxInWindow;
        this.windowMs = windowMs;
    }
    /** Records an attempt; throws when over the limit. */
    consume(now = Date.now()) {
        this.evict(now);
        if (this.events.length >= this.maxInWindow) {
            throw new RateLimitError(this.maxInWindow, this.windowMs);
        }
        this.events.push(now);
    }
    /** Test seam — non-throwing variant. */
    tryConsume(now = Date.now()) {
        this.evict(now);
        if (this.events.length >= this.maxInWindow)
            return false;
        this.events.push(now);
        return true;
    }
    evict(now) {
        const cutoff = now - this.windowMs;
        while (this.events.length > 0 && this.events[0] < cutoff) {
            this.events.shift();
        }
    }
}
export class RateLimitError extends Error {
    maxInWindow;
    windowMs;
    code = 'rate-limit';
    constructor(maxInWindow, windowMs) {
        super(`rate limit: ${maxInWindow} per ${windowMs}ms`);
        this.maxInWindow = maxInWindow;
        this.windowMs = windowMs;
        this.name = 'RateLimitError';
    }
}
//# sourceMappingURL=no-progress-detector.js.map