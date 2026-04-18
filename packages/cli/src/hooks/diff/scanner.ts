// Section D — Diff Scanner Facade
import { getFileDiff } from './extractor.js';
import { matchDenyPatterns } from './deny-matcher.js';
import { checkRequirePatterns } from './require-checker.js';
import type { DenyMatch } from './deny-matcher.js';
import type { RequireViolation } from './require-checker.js';
import type { DenyPattern, RequirePattern } from '../convention/types.js';

export interface ScanResult {
  filePath: string;
  denyMatches: DenyMatch[];
  requireViolations: RequireViolation[];
  passed: boolean;
}

export interface ScanOptions {
  diffOutput: string;
  filePath: string;
  denyPatterns: DenyPattern[];
  requirePatterns: RequirePattern[];
}

/**
 * Scan a file diff for convention violations.
 * Composes extractor + deny matcher + require checker.
 */
export function scanDiff(options: ScanOptions): ScanResult {
  const fileDiff = getFileDiff(options.diffOutput, options.filePath);

  if (!fileDiff) {
    return {
      filePath: options.filePath,
      denyMatches: [],
      requireViolations: [],
      passed: true,
    };
  }

  const allLines = fileDiff.hunks.flatMap((h) => h.lines);

  const denyMatches = matchDenyPatterns(allLines, options.denyPatterns);
  const requireViolations = checkRequirePatterns(allLines, options.requirePatterns);

  return {
    filePath: options.filePath,
    denyMatches,
    requireViolations,
    passed: denyMatches.length === 0 && requireViolations.length === 0,
  };
}
