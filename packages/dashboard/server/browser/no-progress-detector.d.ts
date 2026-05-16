/**
 * No-progress detector — fires when the agent takes N actions in a row
 * without changing `(url, viewportHash, lastInteractionType)`. Prevents
 * the agent from looping on the same dead-end page.
 *
 * The harness emits `__anvilBrowseStalled` to the agent when the
 * threshold is hit; the agent's prompt instructs it to call
 * `browser.done` in response.
 */
export interface ProgressTuple {
    url: string;
    viewportHash: string;
    lastInteractionType: string;
}
export interface NoProgressOpts {
    threshold?: number;
}
export declare class NoProgressDetector {
    private readonly threshold;
    private last;
    private streak;
    constructor(opts?: NoProgressOpts);
    /** Returns true when the action stalled the loop and should be reported. */
    observe(t: ProgressTuple): {
        stalled: boolean;
        streak: number;
    };
    reset(): void;
}
/**
 * Per-session rate limiter for screenshot / click actions. Prevents
 * vision-token griefing + tool-spam on the same session.
 *
 *   click       → 1 / sec
 *   screenshot  → 6 / minute (~1 every 10s)
 */
export declare class RateLimiter {
    private readonly windowMs;
    private readonly maxInWindow;
    private readonly events;
    constructor(maxInWindow: number, windowMs: number);
    /** Records an attempt; throws when over the limit. */
    consume(now?: number): void;
    /** Test seam — non-throwing variant. */
    tryConsume(now?: number): boolean;
    private evict;
}
export declare class RateLimitError extends Error {
    readonly maxInWindow: number;
    readonly windowMs: number;
    readonly code = "rate-limit";
    constructor(maxInWindow: number, windowMs: number);
}
//# sourceMappingURL=no-progress-detector.d.ts.map