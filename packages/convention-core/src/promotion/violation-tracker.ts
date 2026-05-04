// Violation tracker — Section F.1

import { join } from 'node:path';
import { readJSONL, appendJSONL } from '@anvil/memory-core/legacy/index.js';
import type { ConventionPaths } from '../paths.js';

export interface ViolationRecord {
  error: string;
  normalizedError: string;
  fix: string;
  project: string;
  timestamp: string;
}

/**
 * Normalize an error string for deduplication.
 * Strips line numbers, paths, and variable parts.
 */
export function normalizeError(error: string): string {
  return error
    .replace(/\b\d+\b/g, 'N')                   // numbers -> N
    .replace(/['"][^'"]*['"]/g, "'STR'")          // string literals
    .replace(/\/[\w./-]+/g, '/PATH')              // file paths
    .replace(/\s+/g, ' ')                         // collapse whitespace
    .trim()
    .toLowerCase();
}

function getViolationsPath(paths: ConventionPaths): string {
  return join(paths.rulesDir, 'violations.jsonl');
}

/**
 * Track a violation (error + fix pair).
 */
export function trackViolation(paths: ConventionPaths, error: string, fix: string, project: string): void {
  const record: ViolationRecord = {
    error,
    normalizedError: normalizeError(error),
    fix,
    project,
    timestamp: new Date().toISOString(),
  };
  appendJSONL(getViolationsPath(paths), record);
}

/**
 * Get the count of a specific normalized error.
 */
export function getViolationCount(paths: ConventionPaths, error: string): number {
  const normalized = normalizeError(error);
  const records = readJSONL<ViolationRecord>(getViolationsPath(paths));
  return records.filter((r) => r.normalizedError === normalized).length;
}

/**
 * Get all violation records.
 */
export function getViolations(paths: ConventionPaths): ViolationRecord[] {
  return readJSONL<ViolationRecord>(getViolationsPath(paths));
}
