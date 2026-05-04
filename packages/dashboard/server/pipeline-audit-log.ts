/**
 * PipelineAuditLog — append-only NDJSON audit trail for team-mode pause
 * decisions (Phase 7).
 *
 * Storage layout:
 *   <anvilHome>/pipeline-audit/
 *   └── <project>/
 *       ├── audit.log          # current file (one JSON object per line)
 *       └── audit.log.1        # previous file after rotation
 *
 * Rotation: when the active file exceeds `ROTATION_BYTES` (5 MB), the
 * active file is renamed to `audit.log.1` (replacing any previous
 * rotation) and a fresh `audit.log` is started on the next append.
 *
 * Robustness: `list()` parses line-by-line and silently skips malformed
 * lines (with a single-line warning to stderr). This keeps a hand-edited
 * or partially-flushed log from taking down the reader.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { AuditEntry, AuditEvent } from './pipeline-reviewers-types.js';

const ROTATION_BYTES = 5 * 1024 * 1024;

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

/** Short random id (12 lowercase hex chars). Sufficient for local audit logs. */
function makeId(): string {
  return randomBytes(6).toString('hex');
}

// ── Filters ──────────────────────────────────────────────────────────────

export interface AuditFilters {
  runId?: string;
  event?: AuditEvent;
  /** ISO; entries at or after this timestamp. */
  since?: string;
  /** Limit to the first N matching entries (after filter). */
  limit?: number;
}

// ── Log ──────────────────────────────────────────────────────────────────

export class PipelineAuditLog {
  private baseDir: string;

  constructor(anvilHome: string) {
    this.baseDir = join(anvilHome, 'pipeline-audit');
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

  /**
   * Append an entry. Rotates the log when > 5 MB. `id` and `at` are
   * generated when not provided.
   */
  record(
    entry: Omit<AuditEntry, 'id' | 'at'> & { at?: string },
  ): AuditEntry {
    const full: AuditEntry = {
      id: makeId(),
      at: entry.at ?? new Date().toISOString(),
      runId: entry.runId,
      project: entry.project,
      event: entry.event,
      actor: entry.actor,
      ...(entry.details !== undefined ? { details: entry.details } : {}),
    };

    const dir = this.projectDir(full.project);
    ensureDir(dir);
    const path = this.logPath(full.project);

    // Check rotation BEFORE appending so we never exceed ROTATION_BYTES by
    // much. The rename happens only if the active file currently exceeds
    // the threshold.
    if (fileSize(path) >= ROTATION_BYTES) {
      try {
        renameSync(path, this.rotatedPath(full.project));
      } catch {
        // On failure we fall through and keep appending — better to log
        // to a now-oversized file than to lose an entry.
      }
    }

    appendFileSync(path, JSON.stringify(full) + '\n', 'utf-8');
    return full;
  }

  /**
   * List entries for a project, optionally filtered. Reads the active log
   * only — rotated files are treated as archival and not merged here (add
   * a dedicated reader if historical queries are required).
   */
  list(project: string, filters: AuditFilters = {}): AuditEntry[] {
    const path = this.logPath(project);
    if (!existsSync(path)) return [];

    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      return [];
    }

    const out: AuditEntry[] = [];
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: AuditEntry;
      try {
        parsed = JSON.parse(line) as AuditEntry;
      } catch {
        process.stderr.write(
          `pipeline-audit-log: skipping malformed line in ${path}\n`,
        );
        continue;
      }
      if (filters.runId && parsed.runId !== filters.runId) continue;
      if (filters.event && parsed.event !== filters.event) continue;
      if (filters.since && parsed.at < filters.since) continue;
      out.push(parsed);
      if (filters.limit !== undefined && out.length >= filters.limit) break;
    }
    return out;
  }

  /**
   * Read the last `limit` entries without loading the full file into
   * memory. Scans backwards in 8 KB chunks and accumulates until `limit`
   * newlines are seen.
   */
  tail(project: string, limit: number): AuditEntry[] {
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
      // Read backwards until we have at least `limit + 1` newlines or we
      // hit the start of the file. The extra one accounts for a possible
      // trailing newline on the final record.
      while (position > 0) {
        const readLen = Math.min(CHUNK, position);
        position -= readLen;
        const chunk = Buffer.alloc(readLen);
        readSync(fd, chunk, 0, readLen, position);
        buffer = Buffer.concat([chunk, buffer]);
        const newlines = countNewlines(buffer);
        if (newlines > limit) break;
      }
      const text = buffer.toString('utf-8');
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      const tailed = lines.slice(Math.max(0, lines.length - limit));

      const out: AuditEntry[] = [];
      for (const line of tailed) {
        try {
          out.push(JSON.parse(line) as AuditEntry);
        } catch {
          process.stderr.write(
            `pipeline-audit-log: skipping malformed tail line in ${path}\n`,
          );
        }
      }
      return out;
    } finally {
      try { closeSync(fd); } catch { /* noop */ }
    }
  }
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a /* \n */) n++;
  }
  return n;
}
