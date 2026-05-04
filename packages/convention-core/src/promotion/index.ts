// Auto-promotion — Section F.3

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { trackViolation, getViolationCount } from './violation-tracker.js';
import { generateRule } from './rule-generator.js';
import type { ConventionRule } from '../rules/types.js';
import type { ConventionPaths } from '../paths.js';

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
 * Tracks the violation, promotes at count >= 3, and persists the rule
 * to `<conventionsDir>/<project>/rules.json` so future runs surface it
 * via `loadRules`.
 */
export function checkAndPromote(
  paths: ConventionPaths,
  error: string,
  fix: string,
  project: string,
): PromotionResult {
  trackViolation(paths, error, fix, project);
  const count = getViolationCount(paths, error);

  if (count >= PROMOTION_THRESHOLD) {
    const rule = generateRule(error, fix, project);
    persistRule(paths, project, rule);
    return { promoted: true, count, rule };
  }

  return { promoted: false, count };
}

/**
 * Append a rule to `<conventionsDir>/<project>/rules.json`. De-duplicates
 * by `id` — the same generated rule on a later run is a no-op. The file
 * is created if missing.
 */
export function persistRule(
  paths: ConventionPaths,
  project: string,
  rule: ConventionRule,
): void {
  const path = join(paths.conventionsDir, project, 'rules.json');
  mkdirSync(dirname(path), { recursive: true });

  let existing: ConventionRule[] = [];
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { rules?: ConventionRule[] };
      existing = Array.isArray(raw.rules) ? raw.rules : [];
    } catch {
      existing = [];
    }
  }

  if (existing.some((r) => r.id === rule.id)) return;
  existing.push(rule);
  writeFileSync(path, JSON.stringify({ rules: existing }, null, 2), 'utf-8');
}
