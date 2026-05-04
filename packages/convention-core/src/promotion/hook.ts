// Promotion hook — Section F.4
// Wires auto-promotion into fix-pattern recorder

import { checkAndPromote } from './index.js';
import type { PromotionResult } from './index.js';
import type { ConventionPaths } from '../paths.js';

/**
 * Hook called when a fix pattern is recorded.
 * Checks if the error has occurred enough times to be promoted to a rule.
 */
export function onFixPatternRecorded(
  paths: ConventionPaths,
  error: string,
  fix: string,
  project: string,
): PromotionResult {
  return checkAndPromote(paths, error, fix, project);
}
