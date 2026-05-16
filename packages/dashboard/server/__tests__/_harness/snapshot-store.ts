/**
 * Minimal file-based snapshot helper for the dashboard harness.
 *
 * Behavior:
 *   - First run: writes the snapshot to disk and passes.
 *   - Subsequent runs: compares against the stored snapshot.
 *   - `ANVIL_SNAPSHOT_UPDATE=1` forces overwrite (intentional regen workflow).
 *
 * Snapshots are JSON with stable key order so diffs are reviewable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Snapshots live alongside the test sources; resolve from compiled location.
// Compiled paths: server/out/__tests__/_harness/snapshot-store.js
//                 server/__tests__/snapshots/<name>.snap
const SNAPSHOT_DIR = join(__dirname, '..', '..', '..', '__tests__', 'snapshots');

function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortKeysReplacer, 2);
}

function sortKeysReplacer(_key: string, val: unknown): unknown {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return val;
}

export interface SnapshotOpts {
  /** Snapshot name — used as the file basename. */
  name: string;
}

export function matchSnapshot(value: unknown, opts: SnapshotOpts): void {
  const path = join(SNAPSHOT_DIR, `${opts.name}.snap`);
  const next = stableStringify(value);

  if (!existsSync(path) || process.env.ANVIL_SNAPSHOT_UPDATE === '1') {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(path, next + '\n', 'utf8');
    return;
  }

  const prev = readFileSync(path, 'utf8').replace(/\n$/, '');
  assert.equal(
    next,
    prev,
    `Snapshot mismatch for "${opts.name}".\n` +
      `Run with ANVIL_SNAPSHOT_UPDATE=1 to update.\n` +
      `Snapshot file: ${path}`,
  );
}
