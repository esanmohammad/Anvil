/**
 * CI Triage Phase 3 — Store.
 *
 * Persists triage reports so the dashboard can show a history of CI failures
 * and so the clusterer can "learn" which suggested fixes actually worked.
 *
 * Storage layout:
 *   <anvilHome>/ci-triage/<project>/
 *   ├── records/<recordId>.json
 *   └── index.json   # Array<{id, createdAt, topPattern?, topSeverity?}>
 *
 * Writes are atomic (write-to-tmp + rename). The index file is rewritten on
 * every record; at realistic volumes (hundreds of records per project)
 * this costs nothing and keeps reads O(1).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  CiFailurePattern,
  CiFailureSeverity,
  CiTriageReport,
} from './ci-log-clusterer.js';

// ── Public types ────────────────────────────────────────────────────────

export interface CiTriageVerifiedFix {
  pattern: CiFailurePattern;
  appliedFix: string;
  worked: boolean;
  at: string;
}

export interface CiTriageRecord {
  id: string;
  project: string;
  ciRunId?: string;
  createdAt: string;
  report: CiTriageReport;
  verifiedFix?: CiTriageVerifiedFix;
}

export interface CiTriageListOptions {
  limit?: number;
  pattern?: CiFailurePattern;
}

export interface LearnedSuggestion {
  pattern: CiFailurePattern;
  fix: string;
  confidence: number;
  timesUsed: number;
}

// ── Internal types ──────────────────────────────────────────────────────

interface IndexEntry {
  id: string;
  createdAt: string;
  topPattern?: CiFailurePattern;
  topSeverity?: CiFailureSeverity;
  ciRunId?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function newRecordId(): string {
  return `ci-triage-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function toIndexEntry(record: CiTriageRecord): IndexEntry {
  const top = record.report.clusters[0];
  const entry: IndexEntry = {
    id: record.id,
    createdAt: record.createdAt,
  };
  if (top) {
    entry.topPattern = top.pattern;
    entry.topSeverity = top.severity;
  }
  if (record.ciRunId) entry.ciRunId = record.ciRunId;
  return entry;
}

// ── Store ───────────────────────────────────────────────────────────────

export class CiTriageStore {
  private baseDir: string;

  constructor(anvilHome: string) {
    this.baseDir = join(anvilHome, 'ci-triage');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ────────────────────────────────────────────────────

  private projectDir(project: string): string {
    const dir = join(this.baseDir, project);
    ensureDir(dir);
    ensureDir(join(dir, 'records'));
    return dir;
  }

  private indexPath(project: string): string {
    return join(this.projectDir(project), 'index.json');
  }

  private recordPath(project: string, id: string): string {
    return join(this.projectDir(project), 'records', `${id}.json`);
  }

  // ── Index I/O ───────────────────────────────────────────────────────

  private readIndex(project: string): IndexEntry[] {
    const data = readJsonSync<IndexEntry[]>(this.indexPath(project));
    if (!Array.isArray(data)) return [];
    return data.filter((entry) => entry && typeof entry.id === 'string');
  }

  private writeIndex(project: string, entries: IndexEntry[]): void {
    // Newest-first for cheap paging.
    const sorted = entries.slice().sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''),
    );
    atomicWriteFileSync(this.indexPath(project), JSON.stringify(sorted, null, 2));
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Persist a new triage report and update the index.
   */
  record(
    project: string,
    report: CiTriageReport,
    ciRunId?: string,
  ): CiTriageRecord {
    const id = newRecordId();
    const createdAt = new Date().toISOString();
    const rec: CiTriageRecord = {
      id,
      project,
      createdAt,
      report,
      ...(ciRunId ? { ciRunId } : {}),
    };

    atomicWriteFileSync(this.recordPath(project, id), JSON.stringify(rec, null, 2));

    const index = this.readIndex(project);
    index.push(toIndexEntry(rec));
    this.writeIndex(project, index);

    return rec;
  }

  /**
   * List records (newest-first) for a project, optionally filtered by
   * top-cluster pattern.
   */
  list(project: string, opts: CiTriageListOptions = {}): CiTriageRecord[] {
    const index = this.readIndex(project);
    let pointers = index;
    if (opts.pattern) {
      pointers = pointers.filter((entry) => entry.topPattern === opts.pattern);
    }
    if (typeof opts.limit === 'number') {
      pointers = pointers.slice(0, Math.max(0, opts.limit));
    }

    const results: CiTriageRecord[] = [];
    for (const pointer of pointers) {
      const rec = readJsonSync<CiTriageRecord>(this.recordPath(project, pointer.id));
      if (rec) results.push(rec);
    }
    return results;
  }

  /** Fetch one record by id. Returns null when the record is missing. */
  get(project: string, id: string): CiTriageRecord | null {
    return readJsonSync<CiTriageRecord>(this.recordPath(project, id));
  }

  /**
   * Record that a fix was applied. Stored on the record so
   * `learnedSuggestions()` can prioritize proven-good fixes.
   */
  markFixApplied(
    project: string,
    id: string,
    fix: CiTriageVerifiedFix | undefined,
  ): CiTriageRecord {
    const rec = this.get(project, id);
    if (!rec) throw new Error(`ci-triage record not found: ${project}/${id}`);
    if (!fix) throw new Error('markFixApplied() requires a fix payload');

    const updated: CiTriageRecord = { ...rec, verifiedFix: fix };
    atomicWriteFileSync(this.recordPath(project, id), JSON.stringify(updated, null, 2));
    return updated;
  }

  /**
   * Aggregate verified fixes into a ranked list. Confidence blends:
   *   - fraction of `worked === true` attempts
   *   - attempt count (saturating after 5 uses)
   * The result is used to promote repeat-successful suggestions.
   */
  learnedSuggestions(project: string): LearnedSuggestion[] {
    const records = this.list(project);
    const bucket = new Map<string, { worked: number; total: number; fix: string; pattern: CiFailurePattern }>();

    for (const rec of records) {
      const vf = rec.verifiedFix;
      if (!vf) continue;
      const key = `${vf.pattern}::${vf.appliedFix}`;
      const prev = bucket.get(key) || { worked: 0, total: 0, fix: vf.appliedFix, pattern: vf.pattern };
      prev.total += 1;
      if (vf.worked) prev.worked += 1;
      bucket.set(key, prev);
    }

    const suggestions: LearnedSuggestion[] = [];
    for (const entry of bucket.values()) {
      const successRate = entry.total === 0 ? 0 : entry.worked / entry.total;
      const usageWeight = Math.min(1, entry.total / 5);
      const confidence = Math.round(successRate * usageWeight * 1000) / 1000;
      suggestions.push({
        pattern: entry.pattern,
        fix: entry.fix,
        confidence,
        timesUsed: entry.total,
      });
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence || b.timesUsed - a.timesUsed);
  }

  /** Lightweight pointer list; used by the dashboard's list view. */
  listPointers(project: string, limit?: number): IndexEntry[] {
    const index = this.readIndex(project);
    if (typeof limit === 'number') return index.slice(0, Math.max(0, limit));
    return index;
  }

  /** List all projects that have at least one triage record on disk. */
  projects(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
}
