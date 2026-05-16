/**
 * `PlanBinding` — the read-only handle a pipeline run carries while
 * executing against a specific plan version.
 *
 * Threaded through `ctx.shared.planBinding` so downstream stages
 * (build / test-gen / validate / ship) can verify their output against
 * the plan that was approved. Frozen at run start; never mutated mid-run.
 */

import type { Plan } from '../utils/plan-types.js';
import { planContentHash } from './hash.js';

export interface PlanBinding {
  slug: string;
  version: number;
  /** sha256(canonical JSON minus contentHash + approval). */
  hash: string;
  /** Short-hash prefix for PR-body stamps + log lines. */
  hashShort: string;
  /** Frozen view of the plan as approved. */
  plan: Readonly<Plan>;
}

/**
 * Compute the binding for a plan. The plan's own `contentHash` field
 * is authoritative when present; recomputed when absent so the binding
 * is always stamped with a correct hash regardless of how the caller
 * built the Plan object.
 */
export function bindPlan(plan: Plan): PlanBinding {
  const hash = plan.contentHash && plan.contentHash.length === 64
    ? plan.contentHash
    : planContentHash(plan);
  return {
    slug: plan.slug,
    version: plan.version,
    hash,
    hashShort: hash.slice(0, 12),
    plan,
  };
}
