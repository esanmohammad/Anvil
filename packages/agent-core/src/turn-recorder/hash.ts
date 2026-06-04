/**
 * Content hashing for replay idempotency keys.
 *
 * Stable JSON-stringify with sorted object keys → sha256 hex. Mirrors
 * core-pipeline's `effect-helpers.ts:contentHash` semantics so an
 * idempotency key computed inside agent-core round-trips against the
 * durable engine's own checks.
 */

import { createHash } from 'node:crypto';

export function contentHashFromArgs(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  // Symbols, functions, bigints fall through as their string form.
  return JSON.stringify(String(value));
}
