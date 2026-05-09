/**
 * Phase F9 — `plan-risk-types` was promoted into `core-pipeline/utils`
 * so cli + dashboard share one canonical risk vocabulary. This file
 * is a back-compat re-export shim so any in-flight branch keeps
 * building.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import {
 *     SCORER_VERSION, SENSITIVE_PATH_PATTERNS,
 *     type RiskTier, type RiskFactor, type RiskScore,
 *   } from '@esankhan3/anvil-core-pipeline';
 */

export {
  SCORER_VERSION,
  SENSITIVE_PATH_PATTERNS,
} from '@esankhan3/anvil-core-pipeline';
export type {
  RiskTier,
  RiskFactor,
  RiskScore,
} from '@esankhan3/anvil-core-pipeline';
