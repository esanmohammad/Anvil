/**
 * Per-error retry engine.
 *
 * Drives a single attempt-loop against one adapter using `RetryPolicy`
 * resolved from the active `ErrorClass`. The fallback walk (Phase 5)
 * sits a layer up and consumes this primitive for each step.
 *
 * Default policy table per ADR R2:
 *   - rate_limit:    5 attempts, exponential, base 1000ms, max 30000ms
 *   - timeout:       3 attempts, linear,      base 500ms,  max 5000ms
 *   - server_5xx:    4 attempts, exponential, base 200ms,  max 5000ms
 *   - auth:          0 attempts, constant     (terminal — surface immediately)
 *   - content_policy: 0 attempts, constant    (terminal)
 *   - invalid_request: 0 attempts, constant   (terminal)
 *   - model_unavailable: 0 attempts, constant (non-terminal — fall back to a
 *     different model immediately; same-model retry can't help)
 *   - unknown:       1 attempt,  constant,    base 1000ms
 *
 * `Retry-After` headers — when present on the thrown error — override
 * the computed backoff for that single delay.
 */

import type { ErrorClass, RetryPolicy } from './types.js';
import { classifyError, parseRetryAfterMs } from './errors.js';

export const DEFAULT_RETRY_POLICY: Record<ErrorClass, RetryPolicy> = {
  rate_limit: { attempts: 5, backoff: 'exponential', baseMs: 1000, maxMs: 30000 },
  timeout: { attempts: 3, backoff: 'linear', baseMs: 500, maxMs: 5000 },
  server_5xx: { attempts: 4, backoff: 'exponential', baseMs: 200, maxMs: 5000 },
  auth: { attempts: 0, backoff: 'constant', baseMs: 0 },
  content_policy: { attempts: 0, backoff: 'constant', baseMs: 0 },
  invalid_request: { attempts: 0, backoff: 'constant', baseMs: 0 },
  model_unavailable: { attempts: 0, backoff: 'constant', baseMs: 0 },
  unknown: { attempts: 1, backoff: 'constant', baseMs: 1000 },
};

export interface RetryAttempt {
  index: number;
  errorClass?: ErrorClass;
  error?: Error;
  delayMs: number;
  durationMs: number;
}

export interface RunWithRetryResult<T> {
  result?: T;
  error?: Error;
  attempts: RetryAttempt[];
}

export interface RunWithRetryDeps {
  /** Resolve the retry policy for a given error class. */
  policyFor: (cls: ErrorClass) => RetryPolicy;
  /**
   * Adapter-specific overrides for `classifyError`. Returning `undefined`
   * falls back to the generic heuristic.
   */
  classify?: (err: unknown) => ErrorClass | undefined;
  /** Sleep — injectable so tests can drive a fake clock. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Time source — injectable for deterministic durations. */
  now?: () => number;
  /** Random source for jitter — injectable for deterministic tests. */
  random?: () => number;
  signal?: AbortSignal;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Run `fn` under the active retry policy. Returns the success result
 * once produced, or the final error after the policy budget is exhausted.
 *
 * Each invocation is recorded in `attempts[]` with its classification,
 * pre-attempt delay, and wall-clock duration.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  deps: RunWithRetryDeps,
): Promise<RunWithRetryResult<T>> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const attempts: RetryAttempt[] = [];

  let attemptIndex = 0;

  while (true) {
    const startedAt = now();
    let outcome: { ok: true; value: T } | { ok: false; err: Error };
    try {
      const value = await fn();
      outcome = { ok: true, value };
    } catch (raw) {
      outcome = { ok: false, err: raw instanceof Error ? raw : new Error(String(raw)) };
    }
    const durationMs = Math.max(0, now() - startedAt);

    if (outcome.ok) {
      attempts.push({ index: attemptIndex, delayMs: 0, durationMs });
      return { result: outcome.value, attempts };
    }

    const cls = deps.classify?.(outcome.err) ?? classifyError(outcome.err);
    const policy = deps.policyFor(cls);
    attempts.push({
      index: attemptIndex,
      errorClass: cls,
      error: outcome.err,
      delayMs: 0,
      durationMs,
    });

    // Budget exhausted (or terminal class with attempts: 0).
    if (attemptIndex >= policy.attempts) {
      return { error: outcome.err, attempts };
    }

    // Compute the next delay. `Retry-After` overrides if present.
    const headerDelay = parseRetryAfterMs(
      (outcome.err as { headers?: Record<string, string | undefined> }).headers,
    );
    const computed = headerDelay ?? computeDelay(policy, attemptIndex, random);
    attempts[attempts.length - 1].delayMs = computed;

    if (computed > 0) {
      try {
        await sleep(computed, deps.signal);
      } catch (e) {
        return { error: e instanceof Error ? e : new Error(String(e)), attempts };
      }
    }

    attemptIndex += 1;
  }
}

export function computeDelay(
  policy: RetryPolicy,
  attemptIndex: number,
  random: () => number,
): number {
  const useJitter = policy.jitter ?? true;
  let base: number;
  switch (policy.backoff) {
    case 'constant':
      base = policy.baseMs;
      break;
    case 'linear':
      base = policy.baseMs * (attemptIndex + 1);
      break;
    case 'exponential':
      base = policy.baseMs * Math.pow(2, attemptIndex);
      break;
  }
  if (policy.maxMs !== undefined) {
    base = Math.min(base, policy.maxMs);
  }
  if (!useJitter) return Math.max(0, Math.round(base));
  // ±25% jitter
  const jitter = base * 0.25;
  const value = base + (random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(value));
}
