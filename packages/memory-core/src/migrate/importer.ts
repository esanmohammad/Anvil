/**
 * Legacy memory importer (Phase 14 — plan §14.1).
 *
 * Scans `<root>/<project>/memories.jsonl` files in the v0 layout and
 * ingests them into a v2 `HybridMemoryStore`. Each legacy `MemoryEntry`
 * becomes a `Memory<string>` with:
 *   - `namespace = {scope: 'project', projectId: <dir name>}`
 *     (or `{scope: 'global'}` for the legacy `global/_global` directory)
 *   - `kind = 'semantic'` + `subtype = legacy.kind` (the legacy
 *     `fix-pattern | success | approach | flaky-test | performance | manual`
 *     vocabulary becomes the v2 `SemanticSubtype`)
 *   - `provenance.createdBy = 'migration'` + `sourceRunId = 'pre-migration'`
 *     (so audit trails can grep the import wave)
 *   - `bitemporal.validAt = legacy.createdAt`, full `decay.strength = 100`
 *
 * Idempotent: re-running with the same legacy file is a no-op because
 * the v2 `id` is preserved from the legacy entry — `HybridMemoryStore.add`
 * upserts on the SQLite primary key, and the JSONL audit trail just gets
 * a fresh tombstone entry per re-import.
 *
 * Side effects: writes a `.pre-migration.bak` next to each legacy
 * `memories.jsonl` before any import. `dryRun: true` skips both the
 * backup and the durable write.
 */

import {
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { readJSONL } from '../legacy/jsonl.js';
import type { MemoryEntry } from '../legacy/types.js';
import { interpretLegacyDir } from '../namespace/path-resolver.js';
import { HardRejectError } from '../scrubber/index.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type {
  Memory,
  MemoryNamespace,
  SemanticSubtype,
} from '../types.js';

const LEGACY_FILE = 'memories.jsonl';

export interface ImportLegacyOptions {
  /** Don't write — return the would-be plan only. */
  dryRun?: boolean;
  /** Skip the per-file `.pre-migration.bak`. */
  skipBackup?: boolean;
  /** ISO-8601 stamped on `provenance.createdAt` (defaults to now). */
  now?: string;
  /** Stderr logger; defaults to `process.stderr.write`. */
  logger?: (line: string) => void;
}

export interface ImportLegacyReport {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  scrubbed: number;
  rejected: number;
  /** Per-namespace breakdown. */
  byNamespace: Record<string, number>;
  errors: Array<{ file: string; entryId?: string; reason: string }>;
}

export function importLegacyMemories(
  legacyRoot: string,
  store: HybridMemoryStore,
  opts: ImportLegacyOptions = {},
): ImportLegacyReport {
  const log = opts.logger ?? ((s: string) => process.stderr.write(s));
  const report: ImportLegacyReport = {
    filesScanned: 0,
    entriesScanned: 0,
    imported: 0,
    skipped: 0,
    scrubbed: 0,
    rejected: 0,
    byNamespace: {},
    errors: [],
  };

  if (!existsSync(legacyRoot)) {
    log(`[anvil-memory-migrate] no legacy root at ${legacyRoot} — nothing to do\n`);
    return report;
  }

  for (const dirent of readdirSync(legacyRoot)) {
    const dirPath = join(legacyRoot, dirent);
    let st;
    try {
      st = statSync(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const legacyFile = join(dirPath, LEGACY_FILE);
    if (!existsSync(legacyFile)) continue;

    report.filesScanned += 1;
    const ns = interpretLegacyDir(dirent);

    if (!opts.dryRun && !opts.skipBackup) {
      const bak = `${legacyFile}.pre-migration.bak`;
      if (!existsSync(bak)) {
        try {
          copyFileSync(legacyFile, bak);
        } catch (err) {
          report.errors.push({
            file: legacyFile,
            reason: `backup failed: ${err instanceof Error ? err.message : err}`,
          });
        }
      }
    }

    const entries = readJSONL(legacyFile) as MemoryEntry[];
    for (const entry of entries) {
      report.entriesScanned += 1;
      try {
        const v2 = legacyToV2Memory(entry, ns, opts.now);
        if (opts.dryRun) {
          report.imported += 1;
          continue;
        }
        const scrubResult = store.add(v2);
        if (scrubResult && scrubResult.redactions.length > 0) {
          report.scrubbed += 1;
        }
        report.imported += 1;
      } catch (err) {
        if (err instanceof HardRejectError) {
          report.rejected += 1;
          report.errors.push({
            file: legacyFile,
            entryId: entry.id,
            reason: `scrubber hard-reject: ${err.message}`,
          });
          continue;
        }
        report.errors.push({
          file: legacyFile,
          entryId: entry.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const key = namespaceKeyForReport(ns);
    report.byNamespace[key] = (report.byNamespace[key] ?? 0) + entries.length;
  }

  log(
    `[anvil-memory-migrate] ${opts.dryRun ? '[dry-run] ' : ''}scanned ${report.filesScanned} files / ${report.entriesScanned} entries; imported ${report.imported}, scrubbed ${report.scrubbed}, rejected ${report.rejected}\n`,
  );
  return report;
}

const LEGACY_KIND_TO_SUBTYPE: Record<string, SemanticSubtype> = {
  'fix-pattern': 'fix-pattern',
  success: 'success',
  approach: 'approach',
  'flaky-test': 'flaky-test',
  performance: 'performance',
  manual: 'manual',
};

function legacyToV2Memory(
  entry: MemoryEntry,
  namespace: MemoryNamespace,
  nowOverride?: string,
): Memory {
  const now = nowOverride ?? new Date().toISOString();
  const subtype = LEGACY_KIND_TO_SUBTYPE[entry.kind] ?? 'manual';
  // ttl: legacy used `expiresAt`. Reverse-derive ttlDays for the v2 row;
  // -1 if expiresAt is malformed or in the past at import time.
  const expiresMs = Date.parse(entry.expiresAt);
  const createdMs = Date.parse(entry.createdAt);
  const ttlDays =
    Number.isFinite(expiresMs) && Number.isFinite(createdMs)
      ? Math.max(1, Math.round((expiresMs - createdMs) / 86_400_000))
      : -1;

  return {
    id: entry.id,
    namespace,
    kind: 'semantic',
    subtype,
    content: entry.content,
    tags: entry.tags ?? [],
    confidence: clamp(entry.confidence ?? 50, 0, 100),
    ttlDays,
    expiresAt: entry.expiresAt,
    bitemporal: { validAt: entry.createdAt },
    decay: { lastAccessed: now, strength: 100, rehearseCount: 0 },
    provenance: {
      createdBy: 'migration',
      createdAt: entry.createdAt,
      sourceRunId: 'pre-migration',
      sourceFile: entry.source,
    },
  };
}

function namespaceKeyForReport(ns: MemoryNamespace): string {
  switch (ns.scope) {
    case 'global':
      return 'global';
    case 'user':
      return `user/${ns.userId}`;
    case 'project':
      return `project/${ns.projectId}`;
    case 'repo':
      return `repo/${ns.projectId}/${ns.repoId}`;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
