/**
 * Phase F10 — `plan-risk-scorer` was promoted into
 * `core-pipeline/utils` so cli + dashboard share one canonical Plan
 * risk scorer. This file is a back-compat re-export shim so any
 * in-flight branch keeps building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import { scorePlan, computeRiskTier, type ScorePlanOpts }
 *     from '@esankhan3/anvil-core-pipeline';
 */

export {
  scorePlan,
  computeRiskTier,
} from '@esankhan3/anvil-core-pipeline';
export type {
  ScorePlanOpts,
} from '@esankhan3/anvil-core-pipeline';
