/**
 * Disk-backed cache for rankRelevantTests results.
 *
 * A ranking is expensive — reading every repo graph and BFS-walking it —
 * so we memoise by the combination of (PR diff, per-repo graph state). The
 * cache key is the hex sha256 of the ChangedSymbol list; graph state is
 * captured in `repoGraphHashes`. If a later lookup provides a different
 * graph-hash for any repo the entry is invalid and treated as a miss.
 *
 * Storage layout:
 *   <anvilHome>/test-relevance-cache/<project>/<diffHash>.json
 *
 * Writes are atomic (tmp + renameSync). Reads tolerate corrupt JSON by
 * dropping the entry. `gc()` removes files older than a caller-supplied
 * threshold and returns the count removed. Everything is sync because the
 * dashboard server already assumes sync FS for its other checkpoint-style
 * stores (see checkpoint-store.ts).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import type { RelevanceResult } from './test-relevance-ranker.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RelevanceCacheEntry {
  diffHash: string;
  repoGraphHashes: Record<string, string>;
  result: RelevanceResult;
  computedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteFileSync(filePath: string, data: string): void {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function readEntrySafe(filePath: string): RelevanceCacheEntry | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.diffHash !== 'string') return null;
    if (typeof obj.computedAt !== 'string') return null;
    if (!obj.result || typeof obj.result !== 'object') return null;
    if (!obj.repoGraphHashes || typeof obj.repoGraphHashes !== 'object') return null;
    return parsed as RelevanceCacheEntry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    process.stderr.write(
      `[test-relevance-cache] skipping corrupt entry ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
}

function sanitizeProject(project: string): string {
  // Guard against path traversal in the project slug. Keep alnum + dash +
  // underscore + dot; collapse anything else to '_'.
  return project.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Detect a stale entry. An entry is fresh only when every repoGraphHash the
 * caller is asking about matches what was recorded at put-time. Extra entries
 * in the stored record are ignored — a caller asking about a subset of repos
 * can still reuse the cached ranking as long as every repo it cares about
 * matches.
 */
function hashesMatch(
  stored: Record<string, string>,
  requested: Record<string, string>,
): boolean {
  for (const [repo, hash] of Object.entries(requested)) {
    if (stored[repo] !== hash) return false;
  }
  // All repos in the requested set match. If the caller supplies FEWER repos
  // than the store has we treat that as a match — the stored result still
  // covers every repo in the requested set.
  return true;
}

/** Helper callers can use to compute a stable hash for a graph. */
export function hashGraph(graph: unknown): string {
  // Canonical JSON — object keys sorted — so equivalent graphs hash the same.
  const json = canonicalJSONStringify(graph);
  return createHash('sha256').update(json).digest('hex');
}

function canonicalJSONStringify(value: unknown): string {
  const replacer = (_key: string, v: unknown): unknown => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(rec).sort()) out[k] = rec[k];
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(value, replacer);
  } catch {
    return String(value);
  }
}

// ── Store ──────────────────────────────────────────────────────────────────

export class TestRelevanceCache {
  private readonly root: string;

  constructor(anvilHome: string) {
    this.root = join(anvilHome, 'test-relevance-cache');
  }

  /**
   * Returns the cached RelevanceResult iff the stored entry matches the
   * requested (project, diffHash) AND every requested repo graph hash.
   * Returns null on miss / corrupt / stale.
   */
  get(
    project: string,
    diffHash: string,
    repoGraphHashes: Record<string, string>,
  ): RelevanceResult | null {
    const file = this.entryPath(project, diffHash);
    if (!existsSync(file)) return null;
    const entry = readEntrySafe(file);
    if (!entry) return null;
    if (entry.diffHash !== diffHash) return null;
    if (!hashesMatch(entry.repoGraphHashes, repoGraphHashes)) return null;
    return entry.result;
  }

  /**
   * Persist a ranking. Overwrites any existing file at the same (project,
   * diffHash) path because a fresh computation supersedes it.
   */
  put(project: string, entry: RelevanceCacheEntry): void {
    const file = this.entryPath(project, entry.diffHash);
    atomicWriteFileSync(file, JSON.stringify(entry));
  }

  /**
   * Delete every entry older than `olderThanMs` milliseconds (by mtime).
   * Returns the number of files removed. Errors on individual files are
   * logged and skipped — gc must not throw mid-walk.
   */
  gc(olderThanMs: number): number {
    if (!existsSync(this.root)) return 0;
    const threshold = Date.now() - Math.max(0, olderThanMs);
    let removed = 0;

    let projects: string[];
    try {
      projects = readdirSync(this.root);
    } catch {
      return 0;
    }

    for (const project of projects) {
      const dir = join(this.root, project);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const file = join(dir, name);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.mtimeMs > threshold) continue;
        try {
          unlinkSync(file);
          removed += 1;
        } catch (err) {
          process.stderr.write(
            `[test-relevance-cache] gc: failed to unlink ${file}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }
      }
    }
    return removed;
  }

  /** Exposed for tests / debugging. */
  entryPath(project: string, diffHash: string): string {
    return join(this.root, sanitizeProject(project), `${diffHash}.json`);
  }
}
