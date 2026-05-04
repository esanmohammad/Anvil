/**
 * symbol-check — verifies that a finding's `targetSymbol` actually exists in
 * the referenced file or, if absent, in sibling files up to 3 directories up.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EnrichedFinding } from '../review-finding-extensions.js';

export interface SymbolCheckResult {
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
]);

function hasSymbol(haystack: string, symbol: string): boolean {
  if (!symbol) return false;
  // Handle dotted paths: "user.email" — we want at least the last segment
  // bounded by word-ish edges, or the full dotted path verbatim.
  if (haystack.includes(symbol)) return true;
  const segments = symbol.split('.').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return false;
  // Simple word-boundary-ish: ensure we're not part of a longer identifier.
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegex(last)}(?:$|[^A-Za-z0-9_$])`);
  return re.test(haystack);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readFileSafe(path: string): string | null {
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    if (s.size > 2_000_000) return null; // skip giant files
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function listCodeFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
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
    if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot !== -1 && CODE_EXTS.has(name.slice(dot))) out.push(p);
    }
  }
  return out;
}

/**
 * If `targetSymbol` is absent, the check is skipped (passed = true). Otherwise:
 *  - Look in `fileContent` first.
 *  - If not found, walk sibling directories up to 3 levels up from the file's
 *    dir (resolved against `repoLocalPath`).
 *  - Returns `passed: false` if the symbol could not be located anywhere.
 */
export function checkSymbolExists(
  finding: EnrichedFinding,
  repoLocalPath: string,
  fileContent: string,
): SymbolCheckResult {
  const symbol = finding.targetSymbol;
  if (!symbol || symbol.trim().length === 0) {
    return { passed: true, detail: 'skipped: no targetSymbol' };
  }

  if (typeof fileContent === 'string' && hasSymbol(fileContent, symbol)) {
    return { passed: true, detail: `symbol found in ${finding.file}` };
  }

  // Resolve starting dir from the finding's file path relative to repo root.
  const absFile = resolve(repoLocalPath, finding.file);
  let currentDir = dirname(absFile);
  const repoRoot = resolve(repoLocalPath);

  for (let level = 0; level < 3; level++) {
    const files = listCodeFiles(currentDir);
    for (const f of files) {
      if (f === absFile) continue;
      const content = readFileSafe(f);
      if (content && hasSymbol(content, symbol)) {
        return {
          passed: true,
          detail: `symbol found in sibling ${f.slice(repoRoot.length + 1)}`,
        };
      }
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    if (parent.length < repoRoot.length) break;
    currentDir = parent;
  }

  return {
    passed: false,
    detail: `symbol "${symbol}" not found in ${finding.file} or nearby files`,
  };
}
