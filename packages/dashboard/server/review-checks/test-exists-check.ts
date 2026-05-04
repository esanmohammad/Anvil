/**
 * test-exists-check — for "missing-test" claims, scan the repo for test files
 * that mention the target symbol. If any exist, the finding is a false alarm.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { EnrichedFinding } from '../review-finding-extensions.js';

export interface TestExistsCheckResult {
  passed: boolean;
  detail?: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  'coverage',
  '.next',
  '.turbo',
]);

const TEST_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
]);

const MAX_FILES = 5000;
const MAX_FILE_BYTES = 500_000;

function isTestPath(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (base.includes('.test.') || base.includes('.spec.')) return true;
  if (/(^|\/)__tests__\//.test(path.replace(/\\/g, '/'))) return true;
  if (base.endsWith('_test.go')) return true;
  if (base.startsWith('test_') && base.endsWith('.py')) return true;
  return false;
}

function* walkTestFiles(root: string): Generator<string> {
  const stack: string[] = [root];
  let count = 0;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) continue;
      const dot = name.lastIndexOf('.');
      if (dot === -1 || !TEST_EXTS.has(name.slice(dot))) continue;
      if (!isTestPath(p)) continue;
      yield p;
      count++;
      if (count >= MAX_FILES) return;
    }
  }
}

/**
 * Drops missing-test findings when any test file either has the target symbol
 * in its filename or mentions it in its body.
 */
export function checkTestExists(
  finding: EnrichedFinding,
  repoLocalPath: string,
): TestExistsCheckResult {
  if (finding.claimType !== 'missing-test') {
    return { passed: true, detail: 'skipped: claim type is not missing-test' };
  }
  const symbol = finding.targetSymbol;
  if (!symbol || symbol.trim().length === 0) {
    return { passed: true, detail: 'skipped: no targetSymbol' };
  }
  const lastSegment = symbol.split('.').pop() ?? symbol;
  if (lastSegment.length < 2) {
    return { passed: true, detail: 'skipped: symbol too short' };
  }

  const root = resolve(repoLocalPath);
  const symbolLower = lastSegment.toLowerCase();
  for (const file of walkTestFiles(root)) {
    const base = basename(file).toLowerCase();
    if (base.includes(symbolLower)) {
      return {
        passed: false,
        detail: `test file references symbol: ${file.slice(root.length + 1)}`,
      };
    }
    try {
      const body = readFileSync(file, 'utf-8');
      if (body.includes(lastSegment)) {
        return {
          passed: false,
          detail: `test body mentions symbol: ${file.slice(root.length + 1)}`,
        };
      }
    } catch {
      // ignore unreadable files
    }
  }

  return { passed: true, detail: 'no existing test covers this symbol' };
}
