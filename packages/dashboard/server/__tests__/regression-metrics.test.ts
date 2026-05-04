/**
 * Tests for regression-metrics.computeRegressionMetrics.
 * node:test + node:assert/strict, no third-party deps.
 *
 * The compute function accepts duck-typed stores — these tests supply plain
 * objects that implement the minimum shape it needs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeRegressionMetrics } from '../regression-metrics.js';
import type { IncidentStore } from '../incident-store.js';
import type { ReplayStore } from '../replay-store.js';
import type { BoundTestsStore, BoundTest } from '../bound-tests.js';

// ── Fixture helpers ──────────────────────────────────────────────────────

interface FakeIncident {
  id: string;
  occurredAt: string;
  severity?: string;
}

interface FakeReplay {
  incidentId: string;
  status: string;
  boundTestFile?: string;
}

function makeDeps(opts: {
  incidents?: FakeIncident[];
  replays?: FakeReplay[];
  bound?: BoundTest[];
}): {
  incidentStore: IncidentStore;
  replayStore: ReplayStore;
  boundStore: BoundTestsStore;
} {
  const incidents = opts.incidents ?? [];
  const replays = opts.replays ?? [];
  const bound = opts.bound ?? [];

  const incidentStore = {
    list: () => incidents.map((i) => ({ id: i.id, occurredAt: i.occurredAt, severity: i.severity })),
    read: (_project: string, id: string) => incidents.find((i) => i.id === id) ?? null,
  } as unknown as IncidentStore;

  const replayStore = {
    list: () => replays.slice(),
  } as unknown as ReplayStore;

  const boundStore = {
    listBound: () => bound.slice(),
  } as unknown as BoundTestsStore;

  return { incidentStore, replayStore, boundStore };
}

function writeAuditLog(lines: object[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-regression-audit-'));
  const file = join(dir, 'audit.log');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function iso(daysAgo: number, hoursOffset = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000 + hoursOffset * 3_600_000).toISOString();
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('computeRegressionMetrics', () => {
  it('returns a zero-state rollup when every store is empty', () => {
    const deps = makeDeps({});
    const m = computeRegressionMetrics('demo', deps);
    assert.equal(m.project, 'demo');
    assert.equal(m.totalIncidents, 0);
    assert.equal(m.guardedIncidents, 0);
    assert.equal(m.percentGuarded, 0);
    assert.equal(m.totalGuards, 0);
    assert.equal(m.catchesLast30d, 0);
    assert.equal(m.catchRate, 0);
    assert.equal(m.avgBindLatencyMs, 0);
    assert.equal(m.overridesLast30d, 0);
    assert.deepEqual(m.overridesPerMonth, []);
    assert.deepEqual(m.incidentsWithoutGuard, []);
    assert.deepEqual(m.topGuardedFiles, []);
    assert.equal(m.timeSeries.length, 30);
  });

  it('computes percentGuarded from guarded / total incidents', () => {
    const incidents: FakeIncident[] = [
      { id: 'i1', occurredAt: iso(10), severity: 'p1' },
      { id: 'i2', occurredAt: iso(8), severity: 'p2' },
      { id: 'i3', occurredAt: iso(6), severity: 'p3' },
      { id: 'i4', occurredAt: iso(4), severity: 'p3' },
    ];
    const bound: BoundTest[] = [
      { filePath: 'tests/i1.spec.ts', incidentId: 'i1', replayId: 'r1', addedAt: iso(9) },
      { filePath: 'tests/i2.spec.ts', incidentId: 'i2', replayId: 'r2', addedAt: iso(7) },
    ];
    const m = computeRegressionMetrics('demo', makeDeps({ incidents, bound }));
    assert.equal(m.totalIncidents, 4);
    assert.equal(m.guardedIncidents, 2);
    assert.equal(m.percentGuarded, 0.5);
    assert.equal(m.totalGuards, 2);
    assert.ok(m.avgBindLatencyMs > 0, 'avg bind latency populated');
  });

  it('increments catchesLast30d from verify-failed audit events', () => {
    const incidents: FakeIncident[] = [{ id: 'i1', occurredAt: iso(20) }];
    const bound: BoundTest[] = [
      { filePath: 'tests/i1.spec.ts', incidentId: 'i1', replayId: 'r1', addedAt: iso(18) },
    ];
    const audit = writeAuditLog([
      { event: 'bound', filePath: 'tests/i1.spec.ts', at: iso(18) },
      { event: 'verify-failed', filePath: 'tests/i1.spec.ts', at: iso(5) },
      { event: 'verify-failed', filePath: 'tests/i1.spec.ts', at: iso(2) },
      { event: 'verified', filePath: 'tests/i1.spec.ts', at: iso(1) }, // not a catch
    ]);
    try {
      const m = computeRegressionMetrics('demo', { ...makeDeps({ incidents, bound }), auditLogFile: audit.path });
      assert.equal(m.catchesLast30d, 2);
      assert.ok(m.catchRate > 0);
      assert.ok(m.avgCatchLatencyMs > 0);
    } finally {
      audit.cleanup();
    }
  });

  it('rolls overrides into per-month buckets sorted chronologically', () => {
    const janOverride = { event: 'overridden', filePath: 'tests/a.spec.ts', at: '2025-01-15T00:00:00.000Z' };
    const febOverride1 = { event: 'overridden', filePath: 'tests/a.spec.ts', at: '2025-02-01T00:00:00.000Z' };
    const febOverride2 = { event: 'overridden', filePath: 'tests/b.spec.ts', at: '2025-02-20T00:00:00.000Z' };
    const audit = writeAuditLog([janOverride, febOverride2, febOverride1]);
    try {
      const m = computeRegressionMetrics('demo', { ...makeDeps({}), auditLogFile: audit.path });
      assert.deepEqual(m.overridesPerMonth, [
        { month: '2025-01', count: 1 },
        { month: '2025-02', count: 2 },
      ]);
    } finally {
      audit.cleanup();
    }
  });

  it('surfaces incidents without a bound guard', () => {
    const incidents: FakeIncident[] = [
      { id: 'i1', occurredAt: iso(10), severity: 'p1' },
      { id: 'i2', occurredAt: iso(5), severity: 'p2' },
    ];
    const bound: BoundTest[] = [
      { filePath: 'tests/i1.spec.ts', incidentId: 'i1', replayId: 'r1', addedAt: iso(9) },
    ];
    const m = computeRegressionMetrics('demo', makeDeps({ incidents, bound }));
    assert.equal(m.incidentsWithoutGuard.length, 1);
    assert.equal(m.incidentsWithoutGuard[0]!.incidentId, 'i2');
    assert.equal(m.incidentsWithoutGuard[0]!.severity, 'p2');
  });

  it('emits a 30-entry time series with oldest first', () => {
    const incidents: FakeIncident[] = [
      { id: 'i1', occurredAt: iso(5) },
      { id: 'i2', occurredAt: iso(5) },
      { id: 'i3', occurredAt: iso(100) }, // outside 30-day window → ignored
    ];
    const bound: BoundTest[] = [
      { filePath: 'tests/i1.spec.ts', incidentId: 'i1', replayId: 'r1', addedAt: iso(3) },
    ];
    const m = computeRegressionMetrics('demo', makeDeps({ incidents, bound }));
    assert.equal(m.timeSeries.length, 30);
    // Oldest first → series[0] is older than series[29].
    assert.ok(m.timeSeries[0]!.date < m.timeSeries[29]!.date);
    const totalIncidentsInSeries = m.timeSeries.reduce((s, p) => s + p.incidents, 0);
    const totalGuardsInSeries = m.timeSeries.reduce((s, p) => s + p.guards, 0);
    assert.equal(totalIncidentsInSeries, 2, 'only in-window incidents counted');
    assert.equal(totalGuardsInSeries, 1);
  });
});

// Silence unused-import complaint on the directory helper we reserved for
// future fixture expansion.
void mkdirSync;
