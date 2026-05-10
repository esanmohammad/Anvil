/**
 * Sandbox workdir state hash — Phase S6.
 *
 * Computes a content-addressed Merkle hash of a workdir so a recorded
 * `sandbox:exec` effect can be safely replayed: if the input state
 * matches the recorded state, the recorded result is correct; if it
 * drifts, throw `SandboxDeterminismViolationError`.
 *
 * Fast-path optimizations:
 *   - Skip-globs (`node_modules/`, `.next/`, `dist/`, `target/`,
 *     `.cargo/`, `.git/`) so big build outputs don't bottleneck.
 *   - Stat cache keyed by `(path, mtime, size)` so re-hashing is
 *     ~free when files haven't changed.
 *
 * Pure module — no FS operations land outside the workdir.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** Default skip-globs — files matching these are NOT included in the hash. */
export const DEFAULT_HASH_SKIP: readonly RegExp[] = Object.freeze([
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)\.cargo(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
]);

export interface HashOptions {
  /** Replace the default skip patterns. */
  skipPatterns?: readonly RegExp[];
  /** Mutable stat cache shared across hashWorkdir calls. */
  statCache?: StatHashCache;
}

/**
 * In-memory stat cache. Keyed on `<absolutePath>|<size>|<mtimeNs>`.
 * Caller owns the cache so multiple replay iterations on the same
 * sandbox can share entries.
 */
export class StatHashCache {
  private readonly entries = new Map<string, string>();

  get(absPath: string, size: number, mtimeMs: number): string | undefined {
    return this.entries.get(this.key(absPath, size, mtimeMs));
  }

  set(absPath: string, size: number, mtimeMs: number, hash: string): void {
    this.entries.set(this.key(absPath, size, mtimeMs), hash);
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private key(absPath: string, size: number, mtimeMs: number): string {
    return `${absPath}|${size}|${Math.floor(mtimeMs)}`;
  }
}

export interface WorkdirHash {
  /** SHA-256 hex digest of the entire workdir Merkle tree. */
  contentHash: string;
  /** Number of files included. */
  fileCount: number;
  /** Total bytes hashed. */
  sizeBytes: number;
  /** Number of stat-cache hits in this run. */
  cacheHits: number;
}

/**
 * Hash a workdir into a deterministic SHA-256 Merkle digest.
 * Result is `'sha256:' + hex` so callers can identify the algorithm.
 */
export async function hashWorkdir(root: string, opts: HashOptions = {}): Promise<WorkdirHash> {
  const skip = opts.skipPatterns ?? DEFAULT_HASH_SKIP;
  const cache = opts.statCache ?? new StatHashCache();

  // Walk in deterministic order so repeated runs produce the same hash.
  const entries: string[] = [];
  for await (const rel of walkSorted(root, '', skip)) entries.push(rel);
  entries.sort();

  let fileCount = 0;
  let sizeBytes = 0;
  let cacheHits = 0;
  const tree = createHash('sha256');

  for (const rel of entries) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    fileCount += 1;
    sizeBytes += stat.size;

    const cached = cache.get(abs, stat.size, stat.mtimeMs);
    let fileHash: string;
    if (cached) {
      fileHash = cached;
      cacheHits += 1;
    } else {
      const buf = await fsp.readFile(abs);
      fileHash = createHash('sha256').update(buf).digest('hex');
      cache.set(abs, stat.size, stat.mtimeMs, fileHash);
    }
    tree.update(rel + '\0' + fileHash + '\n');
  }

  return {
    contentHash: 'sha256:' + tree.digest('hex'),
    fileCount,
    sizeBytes,
    cacheHits,
  };
}

async function* walkSorted(
  root: string,
  rel: string,
  skip: readonly RegExp[],
): AsyncIterable<string> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip.some((re) => re.test(childRel))) continue;
    if (entry.isDirectory()) {
      yield* walkSorted(root, childRel, skip);
    } else if (entry.isFile()) {
      yield childRel;
    }
  }
}
