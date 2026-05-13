/**
 * Content hashing for plans.
 *
 * `planContentHash(plan)` returns sha256(canonical JSON) excluding the
 * fields that derive from the hash itself (`contentHash`, `approval`,
 * `updatedAt`). The same hash gets stamped onto the PR body and the
 * run record so a reviewer can navigate PR → run → plan in one click.
 */

import { createHash } from 'node:crypto';
import type { Plan } from '../utils/plan-types.js';

/**
 * Fields to ignore when computing the hash — they derive from the hash
 * itself (`contentHash`), invalidate-on-bump (`approval`), or change on
 * every render (`updatedAt`).
 */
const HASH_EXCLUDED_KEYS = new Set<string>([
  'contentHash',
  'approval',
  'updatedAt',
]);

/**
 * Stable JSON.stringify — recursively sorts object keys so the hash is
 * insensitive to key order. Arrays are NOT sorted (order is meaningful
 * for plan.repos / contracts / risks). Excluded keys are dropped.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => !HASH_EXCLUDED_KEYS.has(k))
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function planContentHash(plan: Plan | Record<string, unknown>): string {
  const canonical = stableStringify(plan);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Convenience — first 12 chars of the hash, what we stamp on PR bodies. */
export function planContentHashShort(plan: Plan | Record<string, unknown>): string {
  return planContentHash(plan).slice(0, 12);
}
