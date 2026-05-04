/**
 * contract-test-writer — materialize AuthoredContractTest[] onto disk in a
 * consumer repo, atomically (tmp + rename) and with header-preserving safety.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { AuthoredContractTest } from './contract-test-author.js';

// ── Public types ────────────────────────────────────────────────────────

export interface WrittenTest {
  /** Absolute path on disk. */
  path: string;
  /** Repo-relative path. */
  repoRelative: string;
  bytes: number;
  /** True when an existing file was replaced. */
  overwrote: boolean;
  /** True when `dryRun` prevented an actual write. */
  skipped?: boolean;
  /** Why a file was skipped (e.g. "hand-edited", "dry-run"). */
  skipReason?: string;
}

export interface WriteOptions {
  /** If true, plan only — return WrittenTest[] without touching disk. */
  dryRun?: boolean;
  /**
   * If true, overwrite even files without the anvil-contract header.
   * Default false: a file without our header is assumed to be hand-edited
   * and will be preserved.
   */
  overwrite?: boolean;
}

// ── Entry point ─────────────────────────────────────────────────────────

export function writeContractTests(
  repoLocalPath: string,
  tests: AuthoredContractTest[],
  opts: WriteOptions = {},
): WrittenTest[] {
  const repoAbs = resolve(repoLocalPath);
  const dryRun = opts.dryRun === true;
  const allowOverwriteHandEdited = opts.overwrite === true;

  const results: WrittenTest[] = [];
  for (const test of tests) {
    const absPath = resolveWithinRepo(repoAbs, test.filePath);
    const repoRelative = relative(repoAbs, absPath);
    const contents = ensureTrailingNewline(test.sourceCode);
    const bytes = Buffer.byteLength(contents, 'utf-8');

    const existed = existsSync(absPath);
    let handEdited = false;
    if (existed) {
      handEdited = !hasAnvilHeader(readOrEmpty(absPath));
    }

    // Skip hand-edited files unless the caller explicitly opts in.
    if (handEdited && !allowOverwriteHandEdited) {
      results.push({
        path: absPath,
        repoRelative,
        bytes: 0,
        overwrote: false,
        skipped: true,
        skipReason: 'existing file has no anvil-contract header (hand-edited)',
      });
      continue;
    }

    if (dryRun) {
      results.push({
        path: absPath,
        repoRelative,
        bytes,
        overwrote: existed,
        skipped: true,
        skipReason: 'dry-run',
      });
      continue;
    }

    try {
      atomicWrite(absPath, contents);
      results.push({
        path: absPath,
        repoRelative,
        bytes,
        overwrote: existed,
      });
    } catch (err) {
      results.push({
        path: absPath,
        repoRelative,
        bytes: 0,
        overwrote: false,
        skipped: true,
        skipReason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

// ── Header detection (for re-generation safety) ─────────────────────────

const HEADER_PATTERN = /^\s*(?:\/\/|#)\s*anvil-contract\b/m;

/**
 * True when the file's first few lines contain the anvil-contract marker.
 * Only the first 4 lines are scanned — cheap and sufficient, since every
 * framework we emit puts the header on line 1 or 2.
 */
export function hasAnvilHeader(text: string): boolean {
  if (!text) return false;
  const head = text.split(/\r?\n/, 4).join('\n');
  return HEADER_PATTERN.test(head);
}

// ── Internals ───────────────────────────────────────────────────────────

function atomicWrite(absPath: string, contents: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.anvil.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, contents, 'utf-8');
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    // Clean up the tmp file before rethrowing.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function readOrEmpty(absPath: string): string {
  try {
    return readFileSync(absPath, 'utf-8');
  } catch {
    return '';
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/**
 * Join and sanity-check that `relPath` does not escape `repoAbs`. Refuses
 * absolute relPaths and any `..` traversal.
 */
function resolveWithinRepo(repoAbs: string, relPath: string): string {
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new Error(`Refusing to write absolute path: ${relPath}`);
  }
  const abs = resolve(repoAbs, relPath);
  const rel = relative(repoAbs, abs);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Refusing to write outside repo: ${relPath}`);
  }
  return abs;
}

/** Exported for integration use: stat a write target without opening it. */
export function sizeOnDisk(absPath: string): number {
  try {
    return statSync(absPath).size;
  } catch {
    return 0;
  }
}

/** Convenience: join an absolute base and repo-relative to an absolute path. */
export function joinRepoPath(repoLocalPath: string, repoRelative: string): string {
  return join(resolve(repoLocalPath), repoRelative);
}
