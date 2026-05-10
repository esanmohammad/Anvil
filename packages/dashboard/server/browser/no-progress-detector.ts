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

export interface ProgressTuple {
  url: string;
  viewportHash: string;
  lastInteractionType: string;
}

export interface NoProgressOpts {
  threshold?: number;
}

export class NoProgressDetector {
  private readonly threshold: number;
  private last: ProgressTuple | undefined;
  private streak = 0;

  constructor(opts: NoProgressOpts = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  }

  /** Returns true when the action stalled the loop and should be reported. */
  observe(t: ProgressTuple): { stalled: boolean; streak: number } {
    if (this.last && t.url === this.last.url
        && t.viewportHash === this.last.viewportHash
        && t.lastInteractionType === this.last.lastInteractionType) {
      this.streak += 1;
    } else {
      this.streak = 1;
    }
    this.last = t;
    return { stalled: this.streak >= this.threshold, streak: this.streak };
  }

  reset(): void {
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
  private readonly windowMs: number;
  private readonly maxInWindow: number;
  private readonly events: number[] = [];

  constructor(maxInWindow: number, windowMs: number) {
    this.maxInWindow = maxInWindow;
    this.windowMs = windowMs;
  }

  /** Records an attempt; throws when over the limit. */
  consume(now = Date.now()): void {
    this.evict(now);
    if (this.events.length >= this.maxInWindow) {
      throw new RateLimitError(this.maxInWindow, this.windowMs);
    }
    this.events.push(now);
  }

  /** Test seam — non-throwing variant. */
  tryConsume(now = Date.now()): boolean {
    this.evict(now);
    if (this.events.length >= this.maxInWindow) return false;
    this.events.push(now);
    return true;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length > 0 && this.events[0] < cutoff) {
      this.events.shift();
    }
  }
}

export class RateLimitError extends Error {
  readonly code = 'rate-limit';
  constructor(public readonly maxInWindow: number, public readonly windowMs: number) {
    super(`rate limit: ${maxInWindow} per ${windowMs}ms`);
    this.name = 'RateLimitError';
  }
}
