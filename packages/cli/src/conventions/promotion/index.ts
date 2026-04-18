// Auto-promotion — Section F.3

import { trackViolation, getViolationCount } from './violation-tracker.js';
import { generateRule } from './rule-generator.js';
import type { ConventionRule } from '../rules/types.js';

export { trackViolation, getViolationCount, normalizeError, getViolations } from './violation-tracker.js';
export type { ViolationRecord } from './violation-tracker.js';
export { generateRule } from './rule-generator.js';

/** Threshold: promote to rule after this many occurrences */
const PROMOTION_THRESHOLD = 3;

export interface PromotionResult {
  promoted: boolean;
  count: number;
  rule?: ConventionRule;
}

/**
 * Check if an error/fix pair should be promoted to a convention rule.
 * Tracks the violation and promotes at count >= 3.
 */
export function checkAndPromote(
  error: string,
  fix: string,
  project: string,
): PromotionResult {
  trackViolation(error, fix, project);
  const count = getViolationCount(error);

  if (count >= PROMOTION_THRESHOLD) {
    const rule = generateRule(error, fix, project);
    return { promoted: true, count, rule };
  }

  return { promoted: false, count };
}
