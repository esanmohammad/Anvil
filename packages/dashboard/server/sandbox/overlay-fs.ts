/**
 * Overlay filesystem helpers — Phase S3.
 *
 * Implements the `overlay` propagation mode from
 * `docs/sandbox-isolation-plan.md` §G.2:
 *
 *   host: /Users/user/project/repo  ──── lower (read-only) ─┐
 *                                                            ├──► sandbox: /workspace
 *   sandbox-private upper (RW)  ────────────────────────────┘
 *
 * The sandbox sees the host workdir as a read-only base. All writes
 * land in a sandbox-private upper layer. At sync-to-host, this module
 * walks the upper, diffs against the lower (host), and applies the
 * delta as add/modify/delete operations.
 *
 * Conflict semantics (§G.2):
 *   - default `host-wins`: if the host file changed during the sandbox
 *     lifetime (mtime drift), the host's content stays and the
 *     sandbox's edit lands in `<file>.anvil-conflict`.
 *   - `sandbox-wins`: ship-stage default — the sandbox always wins,
 *     no conflict file.
 *
 * Pure module: no Docker required. The Docker runner uses `docker cp`
 * to populate the upper directory from inside the container; this
 * module then handles the diff walk + apply.
 */

import { promises as fsp, type Stats } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type ConflictPolicy = 'host-wins' | 'sandbox-wins';

export interface OverlayDiff {
  /** Files present in upper but missing in host. */
  added: string[];
  /** Files present in both with different content. */
  modified: string[];
  /** Files marked as removed in the upper (whiteout file). */
  removed: string[];
  /** Files where host changed during sandbox life — recorded but not
   *  silently applied. The caller's policy determines who wins. */
  conflicts: string[];
}

export interface ApplyResult extends OverlayDiff {
  conflictResolution: 'sandbox-wins' | 'host-wins' | 'merged';
  /** Conflict files written next to the original (`<path>.anvil-conflict`). */
  conflictFiles: string[];
}

export interface ApplyOptions {
  /** When `true`, do everything except write to the host. */
  dryRun?: boolean;
  /** Resolution policy. Default `host-wins`. */
  policy?: ConflictPolicy;
  /** Mtime baseline of the host workdir at sandbox-start. Conflict
   *  detection compares each host file's current mtime against this
   *  map; missing entries treat the host file as unchanged (i.e. the
   *  sandbox wins for files that didn't exist when the sandbox started). */
  baselineMtimes?: Map<string, number>;
  /** Skip-globs — files matching these are NEVER propagated. Default
   *  excludes `node_modules`, `.git`, `dist`, build outputs. */
  skipPatterns?: readonly RegExp[];
}

const DEFAULT_SKIP: readonly RegExp[] = Object.freeze([
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)\.cargo(\/|$)/,
]);

const WHITEOUT_PREFIX = '.wh.';

// ───────────────────────────────────────────────────────────────────────
// Capture mtimes — to detect "host changed during sandbox lifetime"
// ───────────────────────────────────────────────────────────────────────

/** Walk the host workdir, recording each file's current mtime in ms. */
export async function captureBaselineMtimes(
  hostRoot: string,
  skipPatterns: readonly RegExp[] = DEFAULT_SKIP,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for await (const rel of walkRelative(hostRoot, '', skipPatterns)) {
    const stat = await fsp.stat(path.join(hostRoot, rel)).catch(() => null);
    if (stat?.isFile()) out.set(rel, stat.mtimeMs);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Diff
// ───────────────────────────────────────────────────────────────────────

/**
 * Diff an upper-layer directory against the host. Returns the set of
 * adds/modifies/removes/conflicts; does NOT write anything.
 */
export async function diffOverlay(
  upperRoot: string,
  hostRoot: string,
  opts: ApplyOptions = {},
): Promise<OverlayDiff> {
  const skip = opts.skipPatterns ?? DEFAULT_SKIP;
  const baseline = opts.baselineMtimes;

  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];

  for await (const rel of walkRelative(upperRoot, '', skip)) {
    const upperAbs = path.join(upperRoot, rel);
    const stat = await fsp.lstat(upperAbs).catch(() => null);
    if (!stat) continue;

    if (rel.split('/').some((seg) => seg.startsWith(WHITEOUT_PREFIX))) {
      const host = whiteoutToPath(rel);
      const exists = await pathExists(path.join(hostRoot, host));
      if (exists) removed.push(host);
      continue;
    }

    if (!stat.isFile()) continue;

    const hostAbs = path.join(hostRoot, rel);
    const hostStat = await fsp.stat(hostAbs).catch(() => null);

    if (!hostStat) {
      added.push(rel);
      continue;
    }

    if (await sameContent(upperAbs, hostAbs)) {
      // Identical — nothing to apply.
      continue;
    }

    if (baseline) {
      const original = baseline.get(rel);
      // If the host's current mtime is newer than the baseline, the host
      // moved during the sandbox's lifetime → conflict.
      if (original !== undefined && hostStat.mtimeMs > original + 1) {
        conflicts.push(rel);
        continue;
      }
    }

    modified.push(rel);
  }

  return { added, modified, removed, conflicts };
}

// ───────────────────────────────────────────────────────────────────────
// Apply
// ───────────────────────────────────────────────────────────────────────

/**
 * Apply the overlay's diff to the host. Returns the lists of files
 * affected and the conflict resolution chosen.
 */
export async function applyOverlay(
  upperRoot: string,
  hostRoot: string,
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  const policy: ConflictPolicy = opts.policy ?? 'host-wins';
  const diff = await diffOverlay(upperRoot, hostRoot, opts);
  const conflictFiles: string[] = [];

  if (!opts.dryRun) {
    for (const rel of diff.added) {
      await copyFile(path.join(upperRoot, rel), path.join(hostRoot, rel));
    }
    for (const rel of diff.modified) {
      await copyFile(path.join(upperRoot, rel), path.join(hostRoot, rel));
    }
    for (const rel of diff.removed) {
      await fsp.rm(path.join(hostRoot, rel), { force: true });
    }
    for (const rel of diff.conflicts) {
      if (policy === 'host-wins') {
        const dst = path.join(hostRoot, rel + '.anvil-conflict');
        await copyFile(path.join(upperRoot, rel), dst);
        conflictFiles.push(rel + '.anvil-conflict');
      } else {
        await copyFile(path.join(upperRoot, rel), path.join(hostRoot, rel));
      }
    }
  }

  const conflictResolution: ApplyResult['conflictResolution'] =
    diff.conflicts.length === 0 ? 'merged' : policy;

  return { ...diff, conflictResolution, conflictFiles };
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

async function copyFile(src: string, dst: string): Promise<void> {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.copyFile(src, dst);
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
  if (statA.size !== statB.size) return false;
  // For equal sizes, hash both. Fast enough for typical edited files.
  const [hashA, hashB] = await Promise.all([hashFile(a), hashFile(b)]);
  return hashA === hashB;
}

async function hashFile(p: string): Promise<string> {
  const buf = await fsp.readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

function whiteoutToPath(rel: string): string {
  // Translate `dir/.wh.foo` → `dir/foo`.
  const parts = rel.split('/');
  const last = parts[parts.length - 1] ?? '';
  if (last.startsWith(WHITEOUT_PREFIX)) {
    parts[parts.length - 1] = last.slice(WHITEOUT_PREFIX.length);
  }
  return parts.join('/');
}

async function* walkRelative(
  root: string,
  rel: string,
  skip: readonly RegExp[],
): AsyncIterable<string> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip.some((re) => re.test(childRel))) continue;
    if (entry.isDirectory()) {
      yield* walkRelative(root, childRel, skip);
    } else if (entry.isFile() || (entry.isSymbolicLink() && entry.name.startsWith(WHITEOUT_PREFIX))) {
      yield childRel;
    }
  }
}

void function _unused(s: Stats) { return s.isFile(); };
