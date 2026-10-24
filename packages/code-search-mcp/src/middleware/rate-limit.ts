/**
 * Sliding-window rate limiting — a request is admitted when fewer than
 * `limit` requests under the same key were admitted in the preceding window
 * (a timestamp log per key, so there is no fixed-window boundary burst).
 *
 * One limiter serves both the per-identity auth limit and the per-(identity,
 * project) P8 quota. In cluster mode the workers call the primary over IPC
 * (see `server.ts`), which runs the single process-wide window — the limit is
 * global to the server, not multiplied by the worker count.
 */

export interface RateDecision {
  ok: boolean;
  /** Seconds until the oldest admitted request leaves the window (0 when ok). */
  retryAfterSec: number;
}

/** `limit <= 0` disables limiting for that key. */
export type RateLimiter = (key: string, limit: number) => Promise<RateDecision>;

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string, limit: number): RateDecision {
    if (limit <= 0) return { ok: true, retryAfterSec: 0 };
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => at > t - this.windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true, retryAfterSec: 0 };
  }

  /** Forget keys with no hit inside the window. */
  prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, at] of this.hits) {
      if (at[at.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}

const processWindow = new SlidingWindow();
setInterval(() => processWindow.prune(), 300_000).unref();

/** The process-wide window (the cluster primary answers worker IPC with it). */
export const localRateLimiter: RateLimiter = async (key, limit) => processWindow.hit(key, limit);

/** Synchronous access to the same window, for callers outside a request. */
export function localRateHit(key: string, limit: number): RateDecision {
  return processWindow.hit(key, limit);
}
