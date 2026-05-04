/**
 * PipelineLearningsStore — persistence for plan-gate decisions.
 *
 * Each decision (approve / modify / reject / timeout / replan) is stored as a
 * {@link PlanApprovalRecord} JSON file. The per-project index keeps newest-
 * first pointers for cheap listing. Aggregation is computed on demand by
 * {@link PipelineLearningsStore.computeStats} — we prefer re-walking the small
 * record set over maintaining a hot rollup on each write.
 *
 * Storage layout:
 *   <anvilHome>/pipeline-learnings/<project>/
 *   ├── records/<recordId>.json
 *   └── index.json   # Array<{id, outcome, decidedAt, riskTier?}>
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
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import type {
  PathApprovalStats,
  PlanApprovalRecord,
  PlanApprovalStats,
  PlanOutcome,
} from './pipeline-learnings-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

interface IndexEntry {
  id: string;
  outcome: PlanOutcome;
  decidedAt: string;
  riskTier?: 'low' | 'med' | 'high';
}

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function newRecordId(): string {
  return `plan-dec-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function toIndexEntry(record: PlanApprovalRecord): IndexEntry {
  const entry: IndexEntry = {
    id: record.id,
    outcome: record.outcome,
    decidedAt: record.decidedAt,
  };
  if (record.riskTier) entry.riskTier = record.riskTier;
  return entry;
}

function isOutcome(value: unknown): value is PlanOutcome {
  return (
    value === 'approved' ||
    value === 'modified' ||
    value === 'rejected' ||
    value === 'timed-out' ||
    value === 'replanned'
  );
}

// ── PipelineLearningsStore ───────────────────────────────────────────────

class PipelineLearningsStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home =
      anvilHome ??
      process.env.ANVIL_HOME ??
      process.env.FF_HOME ??
      join(homedir(), '.anvil');
    this.baseDir = join(home, 'pipeline-learnings');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private recordsDir(project: string): string {
    return join(this.projectDir(project), 'records');
  }

  private recordPath(project: string, recordId: string): string {
    return join(this.recordsDir(project), `${recordId}.json`);
  }

  private indexPath(project: string): string {
    return join(this.projectDir(project), 'index.json');
  }

  // ── Index ─────────────────────────────────────────────────────────────

  private readIndex(project: string): IndexEntry[] {
    return readJsonSync<IndexEntry[]>(this.indexPath(project)) ?? [];
  }

  private writeIndex(project: string, entries: IndexEntry[]): void {
    ensureDir(this.projectDir(project));
    // Newest-first: ISO timestamps sort lexically.
    entries.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
    atomicWriteFileSync(this.indexPath(project), JSON.stringify(entries, null, 2));
  }

  private upsertIndex(project: string, record: PlanApprovalRecord): void {
    const entries = this.readIndex(project);
    const idx = entries.findIndex((e) => e.id === record.id);
    const entry = toIndexEntry(record);
    if (idx === -1) entries.push(entry);
    else entries[idx] = entry;
    this.writeIndex(project, entries);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Record a new decision. The caller does not supply `id` or `decidedAt`
   * (unless it wants to override the timestamp — e.g. when backfilling from
   * a historical pause record).
   */
  record(
    project: string,
    input: Omit<PlanApprovalRecord, 'id' | 'decidedAt' | 'project'> & {
      decidedAt?: string;
    },
  ): PlanApprovalRecord {
    ensureDir(this.recordsDir(project));
    const full: PlanApprovalRecord = {
      ...input,
      id: newRecordId(),
      project,
      decidedAt: input.decidedAt ?? new Date().toISOString(),
    };
    atomicWriteFileSync(this.recordPath(project, full.id), JSON.stringify(full, null, 2));
    this.upsertIndex(project, full);
    return full;
  }

  get(project: string, id: string): PlanApprovalRecord | null {
    return readJsonSync<PlanApprovalRecord>(this.recordPath(project, id));
  }

  /**
   * List decisions, newest first. Filters applied at the index level where
   * possible (outcome/since) to avoid reading every record file unnecessarily;
   * the `limit` slice happens *after* hydration so filters always yield the
   * freshest matching rows.
   */
  list(
    project: string,
    opts: { limit?: number; since?: string; outcome?: PlanOutcome } = {},
  ): PlanApprovalRecord[] {
    const entries = this.readIndex(project);
    const filtered = entries.filter((e) => {
      if (opts.outcome && e.outcome !== opts.outcome) return false;
      if (opts.since && e.decidedAt < opts.since) return false;
      return true;
    });
    const sliced = opts.limit != null ? filtered.slice(0, opts.limit) : filtered;
    const records: PlanApprovalRecord[] = [];
    for (const e of sliced) {
      const rec = this.get(project, e.id);
      if (rec) records.push(rec);
    }
    return records;
  }

  /**
   * Recompute the full stats roll-up across all recorded decisions for a
   * project. Called lazily from the WS handler that powers the Insights UI.
   */
  computeStats(project: string): PlanApprovalStats {
    const records = this.listAll(project);
    const nowIso = new Date().toISOString();

    if (records.length === 0) {
      return {
        projectSlug: project,
        totalPlans: 0,
        approvalRate: 0,
        modificationRate: 0,
        rejectionRate: 0,
        avgDecisionLatencyMs: 0,
        byPath: [],
        byRiskTier: {
          low: { total: 0, approvalRate: 0 },
          med: { total: 0, approvalRate: 0 },
          high: { total: 0, approvalRate: 0 },
        },
        topRejectionReasons: [],
        updatedAt: nowIso,
      };
    }

    // ── Top-level counts ──
    let approved = 0;
    let modified = 0;
    let rejected = 0;
    let latencyTotal = 0;
    let latencyCount = 0;

    // ── Per-path accumulator ──
    const pathBuckets = new Map<
      string,
      {
        total: number;
        approved: number;
        modified: number;
        rejected: number;
        latencySum: number;
        latencyCount: number;
      }
    >();

    // ── Per-risk-tier accumulator ──
    const tierBuckets: Record<'low' | 'med' | 'high', { total: number; approved: number }> = {
      low: { total: 0, approved: 0 },
      med: { total: 0, approved: 0 },
      high: { total: 0, approved: 0 },
    };

    // ── Rejection-reason frequency ──
    const rejectionCounts = new Map<string, number>();

    for (const r of records) {
      if (r.outcome === 'approved') approved++;
      else if (r.outcome === 'modified') modified++;
      else if (r.outcome === 'rejected') rejected++;

      if (typeof r.decisionLatencyMs === 'number' && r.decisionLatencyMs >= 0) {
        latencyTotal += r.decisionLatencyMs;
        latencyCount++;
      }

      // We treat `modified` as a soft approval for per-path signals — the
      // planner still produced something the user accepted, just with edits.
      // But we also surface the modification count separately so the UI can
      // distinguish "shipped verbatim" from "shipped with edits".
      for (const path of r.touchedTopLevelDirs) {
        const b = pathBuckets.get(path) ?? {
          total: 0,
          approved: 0,
          modified: 0,
          rejected: 0,
          latencySum: 0,
          latencyCount: 0,
        };
        b.total++;
        if (r.outcome === 'approved') b.approved++;
        else if (r.outcome === 'modified') b.modified++;
        else if (r.outcome === 'rejected') b.rejected++;
        if (typeof r.decisionLatencyMs === 'number' && r.decisionLatencyMs >= 0) {
          b.latencySum += r.decisionLatencyMs;
          b.latencyCount++;
        }
        pathBuckets.set(path, b);
      }

      if (r.riskTier) {
        const tb = tierBuckets[r.riskTier];
        tb.total++;
        if (r.outcome === 'approved' || r.outcome === 'modified') tb.approved++;
      }

      if (r.outcome === 'rejected' && r.rejectionReason) {
        const key = r.rejectionReason.trim();
        if (key.length > 0) {
          rejectionCounts.set(key, (rejectionCounts.get(key) ?? 0) + 1);
        }
      }
    }

    const total = records.length;
    const byPath: PathApprovalStats[] = [...pathBuckets.entries()]
      .map(([path, b]) => ({
        path,
        total: b.total,
        approved: b.approved,
        modified: b.modified,
        rejected: b.rejected,
        approvalRate: b.total === 0 ? 0 : (b.approved + b.modified) / b.total,
        avgDecisionLatencyMs: b.latencyCount === 0 ? 0 : b.latencySum / b.latencyCount,
      }))
      .sort((a, b) => b.total - a.total);

    const byRiskTier = {
      low: {
        total: tierBuckets.low.total,
        approvalRate: tierBuckets.low.total === 0 ? 0 : tierBuckets.low.approved / tierBuckets.low.total,
      },
      med: {
        total: tierBuckets.med.total,
        approvalRate: tierBuckets.med.total === 0 ? 0 : tierBuckets.med.approved / tierBuckets.med.total,
      },
      high: {
        total: tierBuckets.high.total,
        approvalRate: tierBuckets.high.total === 0 ? 0 : tierBuckets.high.approved / tierBuckets.high.total,
      },
    };

    const topRejectionReasons = [...rejectionCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 5);

    return {
      projectSlug: project,
      totalPlans: total,
      // We treat "modified" as a partial win: user approved the direction but
      // corrected the scope. The overall approvalRate below counts only clean
      // approvals; use modificationRate for the edit-through-acceptance ratio.
      approvalRate: approved / total,
      modificationRate: modified / total,
      rejectionRate: rejected / total,
      avgDecisionLatencyMs: latencyCount === 0 ? 0 : latencyTotal / latencyCount,
      byPath,
      byRiskTier,
      topRejectionReasons,
      updatedAt: nowIso,
    };
  }

  /** Read every record file for a project (used by computeStats). */
  private listAll(project: string): PlanApprovalRecord[] {
    const dir = this.recordsDir(project);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    const out: PlanApprovalRecord[] = [];
    for (const f of files) {
      const rec = readJsonSync<PlanApprovalRecord>(join(dir, f));
      if (rec && isOutcome(rec.outcome)) out.push(rec);
    }
    return out;
  }
}

export { PipelineLearningsStore };
