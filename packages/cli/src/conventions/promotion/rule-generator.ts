// Rule generator — Section F.2

import type { ConventionRule } from '../rules/types.js';
import { normalizeError } from './violation-tracker.js';

/**
 * Generate a deny rule from a recurring error pattern.
 */
export function generateRule(
  error: string,
  fix: string,
  project: string,
): ConventionRule {
  const normalized = normalizeError(error);

  // Extract a regex pattern from the error
  // Escape special regex chars and replace normalized tokens back with flexible patterns
  const pattern = normalized
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/n/g, '\\d+')
    .replace(/'str'/g, "'[^']*'");

  const id = `auto-${project}-${Date.now()}`;

  return {
    id,
    name: `Auto-generated rule for: ${error.slice(0, 60)}`,
    description: `Automatically promoted from recurring error pattern.\nFix: ${fix}`,
    severity: 'warning',
    filePattern: '*',
    deny: pattern,
    message: `Known issue: ${fix}`,
    enabled: true,
  };
}
