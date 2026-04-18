// Convention checker — Wave 9, Section B
// Checks a diff against convention rules

import type { ConventionRule, RuleViolation } from '../conventions/rules/types.js';
import { evaluateRules } from '../conventions/rules/engine.js';
import type { DiffFile } from './diff-reviewer.js';
import { parseDiff } from './diff-reviewer.js';

export interface ConventionCheckResult {
  totalFiles: number;
  totalViolations: number;
  violations: RuleViolation[];
  score: number; // 0-100
}

/**
 * Check diff content against convention rules.
 * Only checks added lines (new code) against the rules.
 */
export function checkConventions(
  diffText: string,
  rules: ConventionRule[],
): ConventionCheckResult {
  const files = parseDiff(diffText);
  const allViolations: RuleViolation[] = [];

  for (const file of files) {
    if (file.additions.length === 0) continue;

    // Reconstruct the added content for evaluation
    const addedContent = file.additions.join('\n');

    // Evaluate rules against the added content
    const violations = evaluateRules(rules, file.path, addedContent);
    allViolations.push(...violations);
  }

  // Score: start at 100, deduct for violations
  const errorCount = allViolations.filter((v) => v.severity === 'error').length;
  const warningCount = allViolations.filter((v) => v.severity === 'warning').length;
  const score = Math.max(0, 100 - errorCount * 15 - warningCount * 5);

  return {
    totalFiles: files.length,
    totalViolations: allViolations.length,
    violations: allViolations,
    score,
  };
}
