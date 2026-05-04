/**
 * Tests for PipelineLearningsStore — node:test + node:assert.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PipelineLearningsStore } from '../pipeline-learnings-store.js';
import type { PlanApprovalRecord, PlanOutcome } from '../pipeline-learnings-types.js';

type RecordInput = Omit<PlanApprovalRecord, 'id' | 'decidedAt' | 'project'> & {
  decidedAt?: string;
};

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-learnings-'));
}

function baseInput(overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    runId: 'run-1',
    planVersion: 1,
    outcome: 'approved' as PlanOutcome,
    riskTier: 'low',
    touchedTopLevelDirs: ['src/auth'],
    decisionLatencyMs: 60_000,
    ...overrides,
  };
}

describe('PipelineLearningsStore', () => {
  let home: string;
  let store: PipelineLearningsStore;

  beforeEach(() => {
    home = tmpHome();
    store = new PipelineLearningsStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('record() persists and the record reappears in list()/get()', () => {
    const rec = store.record('demo', baseInput());
    assert.ok(rec.id.startsWith('plan-dec-'));
    assert.equal(rec.project, 'demo');
    assert.ok(rec.decidedAt, 'decidedAt should be auto-set');

    const all = store.list('demo');
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, rec.id);

    const fetched = store.get('demo', rec.id);
    assert.ok(fetched);
    assert.equal(fetched.runId, 'run-1');
    assert.deepEqual(fetched.touchedTopLevelDirs, ['src/auth']);
  });

  it('computeStats returns a zero-state when the project has no records', () => {
    const s = store.computeStats('empty-project');
    assert.equal(s.totalPlans, 0);
    assert.equal(s.approvalRate, 0);
    assert.equal(s.modificationRate, 0);
    assert.equal(s.rejectionRate, 0);
    assert.equal(s.avgDecisionLatencyMs, 0);
    assert.deepEqual(s.byPath, []);
    assert.deepEqual(s.topRejectionReasons, []);
    assert.equal(s.byRiskTier.low.total, 0);
    assert.equal(s.byRiskTier.med.total, 0);
    assert.equal(s.byRiskTier.high.total, 0);
  });

  it('computes approval/modification/rejection rates on mixed outcomes', () => {
    store.record('demo', baseInput({ runId: 'r1', outcome: 'approved', decisionLatencyMs: 10_000 }));
    store.record('demo', baseInput({ runId: 'r2', outcome: 'approved', decisionLatencyMs: 30_000 }));
    store.record('demo', baseInput({ runId: 'r3', outcome: 'modified', decisionLatencyMs: 50_000 }));
    store.record('demo', baseInput({ runId: 'r4', outcome: 'rejected', decisionLatencyMs: 70_000 }));

    const s = store.computeStats('demo');
    assert.equal(s.totalPlans, 4);
    assert.equal(s.approvalRate, 0.5);
    assert.equal(s.modificationRate, 0.25);
    assert.equal(s.rejectionRate, 0.25);
    // (10 + 30 + 50 + 70) / 4 = 40_000
    assert.equal(s.avgDecisionLatencyMs, 40_000);
  });

  it('byPath is grouped across records and sorted desc by total', () => {
    store.record('demo', baseInput({ runId: 'r1', touchedTopLevelDirs: ['src/auth'] }));
    store.record('demo', baseInput({ runId: 'r2', touchedTopLevelDirs: ['src/auth', 'docs'] }));
    store.record('demo', baseInput({
      runId: 'r3',
      outcome: 'rejected',
      touchedTopLevelDirs: ['src/auth'],
    }));
    store.record('demo', baseInput({ runId: 'r4', touchedTopLevelDirs: ['docs'] }));

    const s = store.computeStats('demo');
    assert.equal(s.byPath.length, 2);
    // src/auth has 3 hits, docs has 2.
    assert.equal(s.byPath[0]!.path, 'src/auth');
    assert.equal(s.byPath[0]!.total, 3);
    assert.equal(s.byPath[0]!.approved, 2);
    assert.equal(s.byPath[0]!.rejected, 1);
    // approvalRate counts modified as soft-approval; here no modifieds: 2/3.
    assert.ok(Math.abs(s.byPath[0]!.approvalRate - 2 / 3) < 1e-9);
    assert.equal(s.byPath[1]!.path, 'docs');
    assert.equal(s.byPath[1]!.total, 2);
  });

  it('byRiskTier buckets by tier and computes per-tier approval rate', () => {
    store.record('demo', baseInput({ runId: 'r1', outcome: 'approved', riskTier: 'low' }));
    store.record('demo', baseInput({ runId: 'r2', outcome: 'approved', riskTier: 'low' }));
    store.record('demo', baseInput({ runId: 'r3', outcome: 'rejected', riskTier: 'high' }));
    store.record('demo', baseInput({ runId: 'r4', outcome: 'modified', riskTier: 'high' }));
    store.record('demo', baseInput({ runId: 'r5', outcome: 'approved', riskTier: 'med' }));

    const s = store.computeStats('demo');
    assert.equal(s.byRiskTier.low.total, 2);
    assert.equal(s.byRiskTier.low.approvalRate, 1);
    assert.equal(s.byRiskTier.med.total, 1);
    assert.equal(s.byRiskTier.med.approvalRate, 1);
    assert.equal(s.byRiskTier.high.total, 2);
    // modified counts as soft approval → 1/2
    assert.equal(s.byRiskTier.high.approvalRate, 0.5);
  });

  it('topRejectionReasons are frequency-sorted and capped at 5', () => {
    const reasons = [
      'too broad', 'too broad', 'too broad',
      'missing tests', 'missing tests',
      'unclear scope',
      'regression risk',
      'perf concern',
      'security concern',
      'security concern',
    ];
    reasons.forEach((reason, i) => {
      store.record('demo', baseInput({
        runId: `r${i}`,
        outcome: 'rejected',
        rejectionReason: reason,
      }));
    });

    const s = store.computeStats('demo');
    assert.equal(s.topRejectionReasons.length, 5, 'cap at 5');
    assert.equal(s.topRejectionReasons[0]!.reason, 'too broad');
    assert.equal(s.topRejectionReasons[0]!.count, 3);
    assert.equal(s.topRejectionReasons[1]!.reason, 'missing tests');
    assert.equal(s.topRejectionReasons[1]!.count, 2);
    assert.equal(s.topRejectionReasons[2]!.reason, 'security concern');
    assert.equal(s.topRejectionReasons[2]!.count, 2);
    // Remaining two spots are the single-count reasons, in any tie-break order;
    // verify counts only.
    assert.equal(s.topRejectionReasons[3]!.count, 1);
    assert.equal(s.topRejectionReasons[4]!.count, 1);
  });

  it('list() supports outcome, since, and limit filters', () => {
    const older = '2024-01-01T00:00:00.000Z';
    const newer = '2025-01-01T00:00:00.000Z';
    store.record('demo', baseInput({ runId: 'old', outcome: 'approved', decidedAt: older }));
    store.record('demo', baseInput({ runId: 'new-approve', outcome: 'approved', decidedAt: newer }));
    store.record('demo', baseInput({ runId: 'new-reject', outcome: 'rejected', decidedAt: newer }));

    const onlyApproved = store.list('demo', { outcome: 'approved' });
    assert.equal(onlyApproved.length, 2);

    const recent = store.list('demo', { since: '2024-06-01T00:00:00.000Z' });
    assert.equal(recent.length, 2);

    const limited = store.list('demo', { limit: 1 });
    assert.equal(limited.length, 1);
  });
});
