/**
 * Effect conversion helpers — Phase E0 of the effect-site
 * conversion plan (`docs/durable-effect-conversion-plan.md`).
 *
 * Every later phase wraps an external touch in
 * `ctx.effect(name, fn, { idempotencyKey })`. Two utilities every
 * site needs:
 *
 *   - `serializeAgentRunResult(r)` strips non-JSON-round-trippable
 *     fields (Set, Map, Buffer, undefined) so the runtime stores
 *     a stable shape on the durable log. Idempotent — passing an
 *     already-serialised value returns it unchanged.
 *   - `contentHash(s)` is a 16-hex-digit SHA-256 prefix used in
 *     idempotency keys for artifact writes. Stable across processes.
 */

import { createHash } from 'node:crypto';

/**
 * Drops fields that don't survive `JSON.parse(JSON.stringify(...))`
 * cleanly. Today's `AgentRunResult` is already JSON-safe (strings +
 * numbers), but future runners might add Sets / Maps; this helper is
 * the central seam.
 */
export function serializeAgentRunResult<T extends Record<string, unknown>>(r: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined) continue;
    if (v instanceof Set) {
      out[k] = Array.from(v);
    } else if (v instanceof Map) {
      out[k] = Object.fromEntries(v.entries());
    } else if (Buffer.isBuffer(v)) {
      out[k] = v.toString('base64');
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** SHA-256 prefix used in idempotency keys for artifact writes. */
export function contentHash(s: string, length = 16): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, length);
}

/**
 * Build a stable idempotency key for an artifact write effect.
 * Format: `<stage>|<scope>|<contentHash>`. Scope is `<repo>` for
 * per-repo writes, `<runId>:stage` for stage-level writes.
 */
export function artifactIdempotencyKey(stage: string, scope: string, body: string): string {
  return `${stage}|${scope}|${contentHash(body)}`;
}
