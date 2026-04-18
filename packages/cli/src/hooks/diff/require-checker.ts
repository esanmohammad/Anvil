// Section D — Require Pattern Checker
import type { DiffLine } from './extractor.js';
import type { RequirePattern } from '../convention/types.js';

export interface RequireViolation {
  pattern: RequirePattern;
  message: string;
}

/**
 * Check that required patterns appear in added lines.
 * Returns violations for patterns that are NOT found.
 */
export function checkRequirePatterns(
  lines: DiffLine[],
  patterns: RequirePattern[],
): RequireViolation[] {
  const violations: RequireViolation[] = [];
  const addedLines = lines.filter((l) => l.type === 'add');
  const addedContent = addedLines.map((l) => l.content).join('\n');

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.pattern, pattern.flags ?? '');
    if (!regex.test(addedContent)) {
      // Only flag if the scope condition is met (e.g. enough new lines)
      if (pattern.minLines !== undefined && addedLines.length < pattern.minLines) {
        continue;
      }
      violations.push({
        pattern,
        message: pattern.message ?? `Required pattern '${pattern.name}' not found in new code`,
      });
    }
  }

  return violations;
}
