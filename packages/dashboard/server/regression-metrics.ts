/**
 * regression-metrics — pure computation of the Regression Guard Insights
 * rollup.
 *
 * Reads from the three existing stores (incidents / replays / bound tests)
 * plus the optional bound-tests audit NDJSON. Writes nothing. Safe to call
 * repeatedly — the dashboard re-computes on every `get-regression-metrics`
 * request rather than maintaining a separate projection.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { IncidentStore } from './incident-store.js';
import type { ReplayStore } from './replay-store.js';
import type { BoundTestsStore, BoundTest } from './bound-tests.js';

import type {
  IncidentWithoutGuard,
  OverrideMonthBucket,
  RegressionGuardMetrics,
  RegressionTimeSeriesPoint,
  TopGuardedFile,
} from './regression-metrics-types.js';

// ── Constants ────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

// ── Audit entry shape (duck-typed — we may be reading a forthcoming
// producer that lives in a separate PR, so we don't import its type here).

interface AuditLogLine {
  event?: string;
  filePath?: string;
  incidentId?: string;
  at?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseTime(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isoDay(ts: number): string {
  // YYYY-MM-DD in UTC.
  return new Date(ts).toISOString().slice(0, 10);
}

function isoMonth(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function readAuditLines(path: string): AuditLogLine[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const out: AuditLogLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AuditLogLine;
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // Append-only logs can have torn final writes — skip quietly.
    }
  }
  return out;
}

function emptyTimeSeries(now: number): RegressionTimeSeriesPoint[] {
  const series: RegressionTimeSeriesPoint[] = [];
  // Oldest first → the sparkline renders left-to-right naturally.
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    series.push({ date: isoDay(now - i * DAY_MS), incidents: 0, guards: 0, catches: 0 });
  }
  return series;
}

// ── Minimal duck-typed store shapes — tests pass in plain objects. ───────

interface IncidentLike {
  id: string;
  occurredAt: string;
  capturedAt?: string;
  severity?: string;
}

interface ReplayLike {
  incidentId: string;
  status: string;
  boundTestFile?: string;
}

interface IncidentStoreLike {
  list(project: string): Array<{ id: string; severity?: string; occurredAt: string }>;
  read(project: string, id: string): IncidentLike | null;
}

interface ReplayStoreLike {
  list(project: string): ReplayLike[];
}

interface BoundStoreLike {
  listBound(project: string): BoundTest[];
}

// ── Main entry point ─────────────────────────────────────────────────────

export function computeRegressionMetrics(
  project: string,
  deps: {
    incidentStore: IncidentStore;
    replayStore: ReplayStore;
    boundStore: BoundTestsStore;
    auditLogFile?: string;
  },
): RegressionGuardMetrics {
  const now = Date.now();
  const windowStart = now - WINDOW_DAYS * DAY_MS;

  // Cast to the duck-typed shapes — keeps the public signature honest while
  // letting tests supply plain-object fixtures.
  const incidentStore = deps.incidentStore as unknown as IncidentStoreLike;
  const replayStore = deps.replayStore as unknown as ReplayStoreLike;
  const boundStore = deps.boundStore as unknown as BoundStoreLike;

  const pointers = incidentStore.list(project);

  // We deliberately do NOT early-return on "no incidents" — audit-log-only
  // projects (override history, verify-failed replays on legacy bound files
  // whose incidents have aged out of the index) should still render.

  // Build lookups keyed by incident id.
  const incidentById = new Map<string, IncidentLike>();
  for (const p of pointers) {
    const full = incidentStore.read(project, p.id);
    if (full) {
      incidentById.set(p.id, full);
    } else {
      // Pointer-only fallback — still counts toward totalIncidents.
      incidentById.set(p.id, { id: p.id, occurredAt: p.occurredAt, severity: p.severity });
    }
  }

  const replays = replayStore.list(project);
  const bound = boundStore.listBound(project);

  // ── Guarded incidents: bound tests include incidentId directly. ────────

  const guardedIncidentIds = new Set<string>();
  for (const b of bound) guardedIncidentIds.add(b.incidentId);

  // ── First-bind time per incident — earliest addedAt wins. ──────────────

  const firstBindByIncident = new Map<string, number>();
  for (const b of bound) {
    const t = parseTime(b.addedAt);
    if (t === null) continue;
    const prev = firstBindByIncident.get(b.incidentId);
    if (prev === undefined || t < prev) firstBindByIncident.set(b.incidentId, t);
  }

  // Incidents with a confirmed replay but no bound record → still not fully
  // guarded; we surface them in `incidentsWithoutGuard` below.
  const confirmedIncidentIds = new Set<string>();
  for (const r of replays) {
    if (r.status === 'confirmed') confirmedIncidentIds.add(r.incidentId);
  }

  // ── Bind latency: incident.occurredAt → first bound.addedAt. ──────────

  let bindLatencySum = 0;
  let bindLatencyCount = 0;
  for (const [incidentId, bindTs] of firstBindByIncident.entries()) {
    const inc = incidentById.get(incidentId);
    const occurred = parseTime(inc?.occurredAt);
    if (occurred === null) continue;
    const delta = bindTs - occurred;
    // Guard against skew / backdated binds showing a negative latency.
    if (delta < 0) continue;
    bindLatencySum += delta;
    bindLatencyCount += 1;
  }

  // ── Audit-log-driven metrics: catches, catch latency, overrides. ───────

  const auditLines = deps.auditLogFile ? readAuditLines(deps.auditLogFile) : [];

  // Earliest bound event per file (fallback for catch latency when we don't
  // have an explicit `bind` entry — use firstBindByIncident as a secondary).
  const firstBoundEventAtByFile = new Map<string, number>();
  for (const line of auditLines) {
    if (line.event !== 'bound' || !line.filePath) continue;
    const t = parseTime(line.at);
    if (t === null) continue;
    const prev = firstBoundEventAtByFile.get(line.filePath);
    if (prev === undefined || t < prev) firstBoundEventAtByFile.set(line.filePath, t);
  }

  const firstVerifyFailedAtByFile = new Map<string, number>();
  let catchesLast30d = 0;
  let overridesLast30d = 0;
  const overridesByMonth = new Map<string, number>();

  for (const line of auditLines) {
    const t = parseTime(line.at);
    if (t === null) continue;

    if (line.event === 'verify-failed' && line.filePath) {
      if (t >= windowStart) catchesLast30d += 1;
      const prev = firstVerifyFailedAtByFile.get(line.filePath);
      if (prev === undefined || t < prev) firstVerifyFailedAtByFile.set(line.filePath, t);
    } else if (line.event === 'overridden') {
      if (t >= windowStart) overridesLast30d += 1;
      const key = isoMonth(t);
      overridesByMonth.set(key, (overridesByMonth.get(key) ?? 0) + 1);
    }
  }

  // Fall back to bound-store addedAt when the audit log has no `bound` line
  // for a given file (e.g. legacy entries written before Phase 2 landed).
  for (const b of bound) {
    if (firstBoundEventAtByFile.has(b.filePath)) continue;
    const t = parseTime(b.addedAt);
    if (t !== null) firstBoundEventAtByFile.set(b.filePath, t);
  }

  // Catch latency: mean delta from earliest bound → first verify-failed.
  let catchLatencySum = 0;
  let catchLatencyCount = 0;
  for (const [filePath, failedAt] of firstVerifyFailedAtByFile.entries()) {
    const boundAt = firstBoundEventAtByFile.get(filePath);
    if (boundAt === undefined) continue;
    const delta = failedAt - boundAt;
    if (delta < 0) continue;
    catchLatencySum += delta;
    catchLatencyCount += 1;
  }

  // ── Overrides per month — sorted chronologically. ──────────────────────

  const overridesPerMonth: OverrideMonthBucket[] = Array.from(overridesByMonth.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  // ── Incidents without a guard. ─────────────────────────────────────────

  const incidentsWithoutGuard: IncidentWithoutGuard[] = [];
  for (const [id, inc] of incidentById.entries()) {
    if (guardedIncidentIds.has(id)) continue;
    // Prefer a confirmed-replay-but-not-bound signal so UX callouts focus
    // there first; fall back to raw unguarded incidents.
    incidentsWithoutGuard.push({
      incidentId: id,
      createdAt: inc.occurredAt ?? inc.capturedAt ?? '',
      severity: inc.severity,
    });
  }
  incidentsWithoutGuard.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // ── Top guarded files — ranked by distinct incidents guarded. ─────────

  const incidentsByFile = new Map<string, Set<string>>();
  for (const b of bound) {
    if (!incidentsByFile.has(b.filePath)) incidentsByFile.set(b.filePath, new Set());
    incidentsByFile.get(b.filePath)!.add(b.incidentId);
  }
  const topGuardedFiles: TopGuardedFile[] = Array.from(incidentsByFile.entries())
    .map(([filePath, set]) => ({ filePath, incidentCount: set.size }))
    .sort((a, b) => b.incidentCount - a.incidentCount || a.filePath.localeCompare(b.filePath))
    .slice(0, 10);

  // ── Daily time series for last 30 days. ────────────────────────────────

  const timeSeries = emptyTimeSeries(now);
  const seriesIdxByDate = new Map<string, number>();
  timeSeries.forEach((p, i) => seriesIdxByDate.set(p.date, i));

  for (const inc of incidentById.values()) {
    const t = parseTime(inc.occurredAt);
    if (t === null || t < windowStart) continue;
    const idx = seriesIdxByDate.get(isoDay(t));
    if (idx !== undefined) timeSeries[idx]!.incidents += 1;
  }

  for (const b of bound) {
    const t = parseTime(b.addedAt);
    if (t === null || t < windowStart) continue;
    const idx = seriesIdxByDate.get(isoDay(t));
    if (idx !== undefined) timeSeries[idx]!.guards += 1;
  }

  for (const line of auditLines) {
    if (line.event !== 'verify-failed') continue;
    const t = parseTime(line.at);
    if (t === null || t < windowStart) continue;
    const idx = seriesIdxByDate.get(isoDay(t));
    if (idx !== undefined) timeSeries[idx]!.catches += 1;
  }

  // ── Finalize rollup. ───────────────────────────────────────────────────

  const totalGuards = bound.length;
  const totalIncidents = incidentById.size;
  const guardedIncidents = guardedIncidentIds.size;

  return {
    project,
    totalIncidents,
    guardedIncidents,
    percentGuarded: totalIncidents === 0 ? 0 : guardedIncidents / totalIncidents,
    totalGuards,
    catchesLast30d,
    // catch rate interpreted as catches-per-guard in the rolling window; when
    // there are zero guards the denominator is undefined → report 0.
    catchRate: totalGuards === 0 ? 0 : catchesLast30d / totalGuards,
    avgBindLatencyMs: bindLatencyCount === 0 ? 0 : Math.round(bindLatencySum / bindLatencyCount),
    avgCatchLatencyMs: catchLatencyCount === 0 ? 0 : Math.round(catchLatencySum / catchLatencyCount),
    overridesLast30d,
    overridesPerMonth,
    incidentsWithoutGuard: incidentsWithoutGuard.slice(0, 25),
    topGuardedFiles,
    timeSeries,
    computedAt: new Date(now).toISOString(),
  };
}
