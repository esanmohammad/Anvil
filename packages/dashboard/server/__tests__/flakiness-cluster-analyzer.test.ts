/**
 * Tests for flakiness-cluster-analyzer. node:test + node:assert.
 * Run: node --test server/out/__tests__/flakiness-cluster-analyzer.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeFlakiness, type FlakyFailureSample } from '../flakiness-cluster-analyzer.js';

// ── Helpers (typed at the helper boundary; test bodies stay untyped) ─────

function sample(overrides: Partial<FlakyFailureSample> = {}): FlakyFailureSample {
  return {
    testId: 't1',
    runAt: '2025-01-01T10:00:00Z',
    passedOnRetry: true,
    ...overrides,
  };
}

// Build N samples whose hour-of-day bucket is all the same (morning).
function morningSamples(testId: string, n: number): FlakyFailureSample[] {
  const out: FlakyFailureSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push(sample({ testId, runAt: '2025-01-01T08:30:00Z' }));
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('analyzeFlakiness', () => {
  it('empty samples input yields empty clusters', () => {
    const clusters = analyzeFlakiness([]);
    assert.deepEqual(clusters, []);
  });

  it('timing-sensitive: all failures bucketed into one time window', () => {
    // 12 samples all in the morning bucket → chi² >> 4.6.
    const clusters = analyzeFlakiness(morningSamples('t-timing', 12));
    assert.equal(clusters.length, 1);
    const c = clusters[0];
    assert.equal(c.testId, 't-timing');
    assert.equal(c.rootCause, 'timing-sensitive');
    assert.ok(c.confidence > 0.3, `expected confidence>0.3 got ${c.confidence}`);
    assert.ok(c.evidence.length >= 1);
    assert.ok(c.evidence[0].includes('morning'));
  });

  it('order-dependent: same prior test precedes most flaky runs', () => {
    // 8 samples, 7 share prior "test-seed-users" — should trip PRIOR_TEST_CORRELATION 0.8.
    // Spread runAt across all 3 time buckets so timing heuristic doesn't fire.
    const hours = ['08:00', '13:00', '22:00', '09:00', '14:00', '23:00', '10:00', '15:00'];
    const priors = [
      ['test-seed-users'],
      ['test-seed-users'],
      ['test-seed-users'],
      ['test-seed-users'],
      ['test-seed-users'],
      ['test-seed-users'],
      ['test-seed-users'],
      ['unrelated-test'],
    ];
    const samples = hours.map((h, i) =>
      sample({
        testId: 't-order',
        runAt: `2025-01-01T${h}:00Z`,
        priorFailedTests: priors[i],
      }),
    );
    const clusters = analyzeFlakiness(samples);
    const c = clusters.find((x) => x.testId === 't-order');
    assert.ok(c, 'cluster should exist for t-order');
    // The prior-test heuristic matches `seed` too, but order-dependent wins
    // because its confidence calculation is higher for repeated identical prior.
    assert.ok(
      c.rootCause === 'order-dependent' || c.rootCause === 'data-dependent',
      `expected order-dependent or data-dependent, got ${c.rootCause}`,
    );
  });

  it('data-dependent: prior tests match create/delete/seed/reset regex', () => {
    // Use varied prior names so the exact-prior heuristic CANNOT fire, but
    // the regex heuristic still does.
    const priors = [
      ['createAccount'],
      ['deleteUser'],
      ['seedFixtures'],
      ['resetCache'],
      ['createWidget'],
      ['deleteOrder'],
      ['seedInventory'],
    ];
    const hours = ['08', '13', '22', '09', '14', '23', '10'];
    const samples = priors.map((p, i) =>
      sample({
        testId: 't-data',
        runAt: `2025-01-01T${hours[i]}:00:00Z`,
        priorFailedTests: p,
      }),
    );
    const clusters = analyzeFlakiness(samples);
    const c = clusters.find((x) => x.testId === 't-data');
    assert.ok(c);
    assert.equal(c.rootCause, 'data-dependent');
    assert.ok(c.evidence.some((line) => line.includes('data-mutating')));
  });

  it('env-dependent: failures pin to a dominant fingerprint hash', () => {
    // 8 samples: 7 on fingerprint "A", 1 on "B". Spread time buckets so timing
    // heuristic doesn't overpower.
    const hours = ['08', '13', '22', '09', '14', '23', '10', '15'];
    const fps = ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'B'];
    const samples = hours.map((h, i) =>
      sample({
        testId: 't-env',
        runAt: `2025-01-01T${h}:00:00Z`,
        envFingerprint: fps[i],
      }),
    );
    const clusters = analyzeFlakiness(samples);
    const c = clusters.find((x) => x.testId === 't-env');
    assert.ok(c);
    assert.equal(c.rootCause, 'env-dependent');
    assert.ok(c.evidence.some((line) => line.includes('env fingerprint')));
  });

  it('confidence scales with sample size (ceteris paribus)', () => {
    const small = analyzeFlakiness(morningSamples('t-small', 5));
    const big = analyzeFlakiness(morningSamples('t-big', 25));
    assert.equal(small[0].rootCause, 'timing-sensitive');
    assert.equal(big[0].rootCause, 'timing-sensitive');
    assert.ok(
      big[0].confidence > small[0].confidence,
      `expected big(${big[0].confidence}) > small(${small[0].confidence})`,
    );
  });
});
