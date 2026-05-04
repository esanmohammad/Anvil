/**
 * BoundTestsAuditLog — append-only NDJSON audit trail for Regression Guard
 * Phase 2 (bound-tests registry override workflow).
 *
 * Every bind / override / verify event lands here so operators can
 * reconstruct the lifetime of a regression test even after the authoritative
 * `bound-tests.json` has been rewritten.
 *
 * Storage layout:
 *   <anvilHome>/bound-tests-audit/
 *   └── <project>/
 *       ├── audit.log        # current file — one JSON object per line
 *       └── audit.log.1      # previous file after rotation
 *
 * Rotation: when the active file exceeds `ROTATION_BYTES` (5 MB) the active
 * file is renamed to `audit.log.1` (replacing any previous rotation) and a
 * fresh `audit.log` is started on the next append. Mirrors the behaviour of
 * `pipeline-audit-log.ts`.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const ROTATION_BYTES = 5 * 1024 * 1024;

// ── Public types ─────────────────────────────────────────────────────────

export type BoundAuditEvent =
  | 'bound'
  | 'overridden'
  | 'verified'
  | 'verify-failed';

export interface BoundAuditEntry {
  id: string;
  project: string;
  filePath: string;
  incidentId?: string;
  event: BoundAuditEvent;
  actor: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface BoundAuditFilters {
  filePath?: string;
  event?: BoundAuditEvent;
  /** ISO timestamp — entries at or after this value pass. */
  since?: string;
  /** Maximum number of matching entries to return. */
  limit?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function makeId(): string {
  return randomBytes(6).toString('hex');
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
}

// ── Log ──────────────────────────────────────────────────────────────────

export class BoundTestsAuditLog {
  private baseDir: string;

  constructor(anvilHome: string) {
    this.baseDir = join(anvilHome, 'bound-tests-audit');
    ensureDir(this.baseDir);
  }

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private logPath(project: string): string {
    return join(this.projectDir(project), 'audit.log');
  }

  private rotatedPath(project: string): string {
    return join(this.projectDir(project), 'audit.log.1');
  }

  /** Append an entry. `id` and `at` are generated when not provided. */
  record(
    entry: Omit<BoundAuditEntry, 'id' | 'at'> & { at?: string },
  ): BoundAuditEntry {
    const full: BoundAuditEntry = {
      id: makeId(),
      at: entry.at ?? new Date().toISOString(),
      project: entry.project,
      filePath: entry.filePath,
      event: entry.event,
      actor: entry.actor,
      ...(entry.incidentId !== undefined ? { incidentId: entry.incidentId } : {}),
      ...(entry.details !== undefined ? { details: entry.details } : {}),
    };

    const dir = this.projectDir(full.project);
    ensureDir(dir);
    const path = this.logPath(full.project);

    if (fileSize(path) >= ROTATION_BYTES) {
      try {
        renameSync(path, this.rotatedPath(full.project));
      } catch {
        // On failure we continue to append — better to oversize than lose an entry.
      }
    }

    appendFileSync(path, JSON.stringify(full) + '\n', 'utf-8');
    return full;
  }

  /**
   * List entries for a project, optionally filtered. Reads the active log
   * only — rotated files are treated as archival.
   */
  list(project: string, filters: BoundAuditFilters = {}): BoundAuditEntry[] {
    const path = this.logPath(project);
    if (!existsSync(path)) return [];

    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      return [];
    }

    const out: BoundAuditEntry[] = [];
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: BoundAuditEntry;
      try {
        parsed = JSON.parse(line) as BoundAuditEntry;
      } catch {
        process.stderr.write(
          `bound-tests-audit: skipping malformed line in ${path}\n`,
        );
        continue;
      }
      if (filters.filePath && parsed.filePath !== filters.filePath) continue;
      if (filters.event && parsed.event !== filters.event) continue;
      if (filters.since && parsed.at < filters.since) continue;
      out.push(parsed);
      if (filters.limit !== undefined && out.length >= filters.limit) break;
    }
    return out;
  }

  /** Read the last `limit` entries without loading the full file. */
  tail(project: string, limit: number): BoundAuditEntry[] {
    const path = this.logPath(project);
    if (!existsSync(path) || limit <= 0) return [];

    const size = fileSize(path);
    if (size === 0) return [];

    const CHUNK = 8 * 1024;
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return [];
    }

    try {
      let position = size;
      let buffer = Buffer.alloc(0);
      while (position > 0) {
        const readLen = Math.min(CHUNK, position);
        position -= readLen;
        const chunk = Buffer.alloc(readLen);
        readSync(fd, chunk, 0, readLen, position);
        buffer = Buffer.concat([chunk, buffer]);
        if (countNewlines(buffer) > limit) break;
      }
      const text = buffer.toString('utf-8');
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      const tailed = lines.slice(Math.max(0, lines.length - limit));

      const out: BoundAuditEntry[] = [];
      for (const line of tailed) {
        try {
          out.push(JSON.parse(line) as BoundAuditEntry);
        } catch {
          process.stderr.write(
            `bound-tests-audit: skipping malformed tail line in ${path}\n`,
          );
        }
      }
      return out;
    } finally {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}
