/**
 * Tests for review-synthesizer — single-verdict synthesis.
 *
 * Uses node:test + node:assert (built-in runner), matching the style of the
 * other tests in this directory. No explicit TS type annotations inside the
 * test bodies (per module contract).
 *
 * Run via:
 *   node --test packages/dashboard/server/__tests__/review-synthesizer.test.ts
 * (after tsc compile, or via a ts loader).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeVerdict } from '../review-synthesizer.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function finding(overrides = {}) {
  return {
    id: 'f',
    severity: 'info',
    category: 'correctness',
    file: 'src/foo.ts',
    line: 1,
    snippet: '',
    description: '',
    suggestedFix: null,
    confidence: 'med',
    resolution: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('synthesizeVerdict', () => {
  it('returns an approve verdict with a clean headline when there are no findings', () => {
    const v = synthesizeVerdict([]);

    assert.equal(v.level, 'approve');
    assert.match(v.headline, /Looks clean/);
    assert.equal(v.blockers.length, 0);
    assert.equal(v.mainFindings.length, 0);
    assert.equal(v.polish.length, 0);
    assert.equal(v.summary.totalFindings, 0);
    assert.equal(v.immutableBlockerCount, 0);
    assert.ok(typeof v.computedAt === 'string' && v.computedAt.length > 0);
  });

  it('raises a blocker verdict when any finding has severity=blocker', () => {
    const v = synthesizeVerdict([
      finding({ id: 'a', severity: 'blocker', persona: 'security' }),
      finding({ id: 'b', severity: 'medium' }),
    ]);

    assert.equal(v.level, 'blocker');
    assert.equal(v.blockers.length, 1);
    assert.match(v.headline, /Must fix before merge/);
    assert.match(v.headline, /1 blocker\./);
    assert.equal(v.immutableBlockerCount, 0);
  });

  it('treats immutable:true findings as blockers even when severity is lower', () => {
    const v = synthesizeVerdict([
      finding({ id: 'a', severity: 'medium', immutable: true }),
      finding({ id: 'b', severity: 'low' }),
    ]);

    assert.equal(v.level, 'blocker');
    assert.equal(v.blockers.length, 1);
    assert.equal(v.immutableBlockerCount, 1);
    assert.match(v.headline, /1 blocker\./);
    // The medium-but-immutable finding should NOT double-count as a main finding.
    assert.equal(v.mainFindings.length, 0);
  });

  it('returns needs-changes when only medium/high severities are present', () => {
    const v = synthesizeVerdict([
      finding({ id: 'a', severity: 'medium' }),
      finding({ id: 'b', severity: 'medium' }),
      finding({ id: 'c', severity: 'high' }),
    ]);

    assert.equal(v.level, 'needs-changes');
    assert.equal(v.blockers.length, 0);
    assert.equal(v.mainFindings.length, 3);
    assert.match(v.headline, /3 things to address/);
    // High-severity finding should be sorted ahead of medium ones.
    const first = v.mainFindings[0];
    assert.ok(first && typeof first === 'object');
    assert.equal((first as { id: string }).id, 'c');
  });

  it('returns approve with polish bucket populated when only low/info findings exist', () => {
    const v = synthesizeVerdict([
      finding({ id: 'a', severity: 'low' }),
      finding({ id: 'b', severity: 'info' }),
      finding({ id: 'c', severity: 'medium', demoted: true }),
    ]);

    assert.equal(v.level, 'approve');
    assert.match(v.headline, /Looks clean/);
    assert.equal(v.polish.length, 3);
    assert.equal(v.mainFindings.length, 0);
    assert.equal(v.blockers.length, 0);
  });

  it('caps mainFindings at 5 and sorts by severity then calibratedConfidence', () => {
    const v = synthesizeVerdict([
      finding({ id: 'm1', severity: 'medium', calibratedConfidence: 0.2 }),
      finding({ id: 'm2', severity: 'medium', calibratedConfidence: 0.9 }),
      finding({ id: 'm3', severity: 'medium', calibratedConfidence: 0.5 }),
      finding({ id: 'h1', severity: 'high', calibratedConfidence: 0.1 }),
      finding({ id: 'h2', severity: 'high', calibratedConfidence: 0.8 }),
      finding({ id: 'h3', severity: 'high', calibratedConfidence: 0.4 }),
      finding({ id: 'm4', severity: 'medium', calibratedConfidence: 0.7 }),
    ]);

    assert.equal(v.level, 'needs-changes');
    assert.equal(v.mainFindings.length, 5);

    const ids = v.mainFindings.map((f) => (f as { id: string }).id);
    // All highs should come first, then mediums, in confidence-desc order within each tier.
    assert.deepEqual(ids, ['h2', 'h3', 'h1', 'm2', 'm4']);
  });
});
