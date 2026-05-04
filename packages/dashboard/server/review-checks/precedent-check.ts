/**
 * precedent-check — for "unusual-pattern" claims, grep the repo for the same
 * quoted pattern. If many precedents exist, the finding is dropped because the
 * pattern is actually established convention.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EnrichedFinding } from '../review-finding-extensions.js';
import { normalizeWhitespace } from '../review-finding-extensions.js';

export interface PrecedentCheckOptions {
  minPrecedents?: number;
}

export interface PrecedentCheckResult {
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
  '.cache',
  '.yarn',
]);

const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.java',
  '.rb',
  '.rs',
  '.php',
  '.kt',
  '.cs',
]);

const MAX_FILES_SCANNED = 5000;
const MAX_FILE_BYTES = 1_000_000;

function* walk(root: string): Generator<string> {
  const stack: string[] = [root];
  let scanned = 0;
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
      } else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        const dot = name.lastIndexOf('.');
        if (dot === -1 || !CODE_EXTS.has(name.slice(dot))) continue;
        yield p;
        scanned++;
        if (scanned >= MAX_FILES_SCANNED) return;
      }
    }
  }
}

function countOccurrencesIn(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * For `claimType === 'unusual-pattern'`: scans the repo for the finding's
 * `quoted` text. If ≥ `minPrecedents` (default 3) matches are found, the
 * check fails (i.e. finding is to be dropped as the pattern is not unusual).
 */
export function checkPrecedent(
  finding: EnrichedFinding,
  repoLocalPath: string,
  opts: PrecedentCheckOptions = {},
): PrecedentCheckResult {
  if (finding.claimType !== 'unusual-pattern') {
    return { passed: true, detail: 'skipped: claim type is not unusual-pattern' };
  }
  const quoted = finding.quoted;
  if (!quoted || quoted.trim().length === 0) {
    return { passed: true, detail: 'skipped: no quoted pattern' };
  }

  const minPrecedents = opts.minPrecedents ?? 3;
  const root = resolve(repoLocalPath);
  const needle = normalizeWhitespace(quoted);
  if (needle.length < 4) {
    // Too generic to be meaningful evidence; don't drop.
    return { passed: true, detail: 'skipped: quoted pattern too short' };
  }

  let total = 0;
  for (const file of walk(root)) {
    let body: string;
    try {
      body = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    total += countOccurrencesIn(normalizeWhitespace(body), needle);
    if (total >= minPrecedents + 1) break; // early-out once we're certain
  }

  if (total >= minPrecedents) {
    return {
      passed: false,
      detail: `found ${total} similar precedents (>= ${minPrecedents})`,
    };
  }
  return {
    passed: true,
    detail: `precedents: ${total} (< ${minPrecedents})`,
  };
}
