/**
 * Helpers that wrap web/browser tool calls in `ctx.effect()` so they
 * record + replay through the durable execution layer (D1–G4).
 *
 * Usage pattern (from a stage that owns a `StepContext`):
 *
 *   const result = await wrapWebEffect(ctx, 'web:search', search.query, () =>
 *     backend.search(args, execCtx),
 *   );
 *
 * On replay, the recorded answer returns instantly; no network call.
 *
 * The wrapper is OPTIONAL — call sites that don't have a `StepContext`
 * (e.g. an agent loop dispatching tool calls inline) get the raw,
 * non-durable behavior. Phase H7 will add full propagation through
 * the agent-core executor seam.
 */

import type { StepContext } from '../types.js';
import { contentHash } from '../durable/effect-helpers.js';

export interface WebEffectOptions {
  /** Stable idempotency key. When two effects share the same key, the
   *  recorded answer is reused. */
  idempotencyKey?: string;
  /** Soft timeout (ms). */
  timeoutMs?: number;
}

/**
 * Wrap a web/browser tool invocation in `ctx.effect()`. The effect name
 * is stage-prefixed by convention (`web:search:<idx>`, `web:fetch:<idx>:<urlHash>`,
 * `browser:navigate:<idx>:<urlHash>`).
 *
 * `key` is used as the idempotency-key suffix and feeds `contentHash()`
 * for stability.
 */
export function wrapWebEffect<T>(
  ctx: StepContext<unknown> | undefined,
  effectName: string,
  key: string,
  fn: () => Promise<T>,
  opts: WebEffectOptions = {},
): Promise<T> {
  if (!ctx || typeof ctx.effect !== 'function') {
    return fn();
  }
  const idempotencyKey = opts.idempotencyKey ?? contentHash(key);
  return ctx.effect(`${effectName}:${idempotencyKey}`, fn, {
    idempotencyKey,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

/** Build the canonical idempotency key for `web.search`. */
export function searchIdempotencyKey(args: {
  query: string;
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
  limit?: number;
}): string {
  return contentHash(JSON.stringify({
    q: args.query,
    a: args.allowedDomains ?? [],
    b: args.blockedDomains ?? [],
    l: args.limit ?? 10,
  }));
}

/** Build the canonical idempotency key for `web.fetch`. */
export function fetchIdempotencyKey(args: {
  url: string;
  prompt: string;
  summarizerModel?: string;
}): string {
  return contentHash(JSON.stringify({
    u: args.url,
    p: args.prompt,
    m: args.summarizerModel ?? '',
  }));
}

/** Build the canonical idempotency key for `browser.navigate`. */
export function navigateIdempotencyKey(args: {
  runId: string;
  sessionId: string;
  url: string;
}): string {
  return contentHash(`${args.runId}|${args.sessionId}|${args.url}`);
}

/** Build the canonical idempotency key for `browser.extract`. */
export function extractIdempotencyKey(args: {
  query: string;
  schemaHash?: string;
  alreadyCollectedHash?: string;
}): string {
  return contentHash(JSON.stringify({
    q: args.query,
    s: args.schemaHash ?? '',
    a: args.alreadyCollectedHash ?? '',
  }));
}
