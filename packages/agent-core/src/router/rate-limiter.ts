/**
 * Token-bucket rate limiter — per-provider RPM (requests/min) + TPM
 * (tokens/min) buckets.
 *
 * Phase 3 ships only the in-process implementation. Cross-process mode
 * (SQLite advisory file) is a deferred add-on once the router has real
 * users running multiple parallel cli invocations against shared keys.
 *
 * Behavior:
 *   - One bucket per (provider, scope) where scope is 'rpm' | 'tpm'.
 *   - Buckets refill linearly at `capacity / 60_000` tokens/ms.
 *   - `acquire(provider, estimatedTokens)` waits until both buckets have
 *     enough tokens, then deducts. Behavior on dry bucket follows
 *     RouterConfig.onRateLimit:
 *       - 'wait' (default) — sleep until tokens are available
 *       - 'fail'           — throw immediately
 *       - 'fallback'       — return false; caller falls back
 *
 * Defaults reflect published provider docs as of 2026-04-29; override
 * via RouterConfig.rateLimit.
 */

import type { RateLimitProviderConfig } from './types.js';

export const DEFAULT_RATE_LIMITS: Record<string, RateLimitProviderConfig> = {
  // Anthropic Tier 4 default (Sonnet 4.6); Haiku is much higher.
  claude: { rpm: 50, tpm: 80_000 },
  // OpenAI Tier 1 default (gpt-4o RPM 500 / TPM 30k).
  openai: { rpm: 500, tpm: 30_000 },
  // Gemini 2.5 Pro default — 1000 RPM, 4M TPM in the AI Studio tier.
  gemini: { rpm: 1000, tpm: 4_000_000 },
  // OpenRouter aggregates upstream limits; default is conservative.
  openrouter: { rpm: 200, tpm: 200_000 },
  // Local providers — effectively unbounded.
  ollama: {},
  'gemini-cli': {},
  adk: {},
};

export interface RateLimiterDeps {
  /** Per-provider override map. Falls back to DEFAULT_RATE_LIMITS. */
  config?: Record<string, RateLimitProviderConfig>;
  /** Time source — injectable for deterministic tests. */
  now?: () => number;
  /** Sleep — injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Behavior when bucket dry. Default 'wait'. */
  onRateLimit?: 'wait' | 'fail' | 'fallback';
}

interface Bucket {
  capacityPerMin: number;
  tokens: number;
  lastRefillMs: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitedError extends Error {
  readonly provider: string;
  readonly waitMs: number;
  constructor(provider: string, waitMs: number) {
    super(`rate limit for provider '${provider}' exhausted; wait ${waitMs}ms`);
    this.name = 'RateLimitedError';
    this.provider = provider;
    this.waitMs = waitMs;
  }
}

export class TokenBucketRateLimiter {
  private readonly config: Record<string, RateLimitProviderConfig>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRateLimit: 'wait' | 'fail' | 'fallback';

  constructor(deps: RateLimiterDeps = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...deps.config };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    this.onRateLimit = deps.onRateLimit ?? 'wait';
  }

  /**
   * Reserve 1 RPM token + N TPM tokens for the provider. If the bucket
   * is dry the behavior depends on the configured `onRateLimit`:
   *   - 'wait' (default): awaits until available
   *   - 'fail': throws RateLimitedError
   *   - 'fallback': returns false; caller falls back
   */
  async acquire(provider: string, estimatedTokens: number): Promise<boolean> {
    const cfg = this.config[provider] ?? {};
    const rpm = cfg.rpm;
    const tpm = cfg.tpm;
    if (rpm === undefined && tpm === undefined) return true; // unbounded

    while (true) {
      this.refillAll(provider);
      const rpmBucket = rpm !== undefined ? this.bucketFor(provider, 'rpm', rpm) : null;
      const tpmBucket = tpm !== undefined ? this.bucketFor(provider, 'tpm', tpm) : null;

      const rpmShort = rpmBucket && rpmBucket.tokens < 1;
      const tpmShort = tpmBucket && tpmBucket.tokens < estimatedTokens;
      if (!rpmShort && !tpmShort) {
        if (rpmBucket) rpmBucket.tokens -= 1;
        if (tpmBucket) tpmBucket.tokens -= estimatedTokens;
        return true;
      }

      const waitMs = Math.max(
        rpmBucket && rpmShort ? this.waitTime(rpmBucket, 1) : 0,
        tpmBucket && tpmShort ? this.waitTime(tpmBucket, estimatedTokens) : 0,
      );

      if (this.onRateLimit === 'fail') {
        throw new RateLimitedError(provider, waitMs);
      }
      if (this.onRateLimit === 'fallback') {
        return false;
      }
      await this.sleep(waitMs);
    }
  }

  /** Best-effort introspection — returns current token counts. */
  snapshot(provider: string): { rpm?: number; tpm?: number } {
    this.refillAll(provider);
    return {
      rpm: this.buckets.get(`${provider}:rpm`)?.tokens,
      tpm: this.buckets.get(`${provider}:tpm`)?.tokens,
    };
  }

  private bucketFor(provider: string, scope: 'rpm' | 'tpm', capacityPerMin: number): Bucket {
    const key = `${provider}:${scope}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { capacityPerMin, tokens: capacityPerMin, lastRefillMs: this.now() };
      this.buckets.set(key, b);
    } else if (b.capacityPerMin !== capacityPerMin) {
      b.capacityPerMin = capacityPerMin;
    }
    return b;
  }

  private refillAll(provider: string): void {
    for (const scope of ['rpm', 'tpm'] as const) {
      const b = this.buckets.get(`${provider}:${scope}`);
      if (!b) continue;
      const now = this.now();
      const elapsed = now - b.lastRefillMs;
      if (elapsed <= 0) continue;
      const refill = (elapsed / 60_000) * b.capacityPerMin;
      b.tokens = Math.min(b.capacityPerMin, b.tokens + refill);
      b.lastRefillMs = now;
    }
  }

  private waitTime(bucket: Bucket, needed: number): number {
    const deficit = needed - bucket.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil((deficit / bucket.capacityPerMin) * 60_000);
  }
}
