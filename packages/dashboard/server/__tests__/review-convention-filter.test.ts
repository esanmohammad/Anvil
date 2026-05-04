/**
 * Tests for review-convention-filter (Review Phase R6).
 *
 * Uses node:test + node:assert — matches the style of the other tests in
 * this directory. Exercises rule building, drop-vs-demote action selection,
 * multi-rule aggregation, and severity downgrade ordering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyConventionFilter,
  buildConventionRules,
} from '../review-convention-filter.js';

// ── Helpers (module-level, so test bodies stay annotation-free) ──────────

function asObj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    assert.fail(`expected object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function sev(value: unknown): string {
  return String(asObj(value).severity);
}

function conf(value: unknown): unknown {
  return asObj(value).confidence;
}

function demotedFlag(value: unknown): unknown {
  return asObj(value).demoted;
}

// ── 1. Drops a contradictory finding ─────────────────────────────────────

describe('applyConventionFilter — drop contradictory finding', () => {
  it('drops "should use semicolons" when project avoids them', () => {
    const fingerprint = { semicolons: { value: 'never', confidence: 0.95 } };
    const findings = [
      {
        id: 'f1',
        severity: 'warn',
        message: 'Missing semicolons; should use semicolons at end of statement.',
      },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.dropped.length, 1);
    assert.equal(report.kept.length, 0);
    assert.equal(report.demoted.length, 0);
    assert.equal(report.dropped[0].rule, 'no-semicolons');
    assert.match(report.dropped[0].detail, /contradicts detected convention/);
  });
});

// ── 2. Demotes at lower confidence ───────────────────────────────────────

describe('applyConventionFilter — demote at 0.5..0.7 confidence', () => {
  it('demotes instead of drops when convention confidence is medium', () => {
    const fingerprint = { quotes: { value: 'single', confidence: 0.6 } };
    const findings = [
      {
        id: 'f2',
        severity: 'error',
        confidence: 'high',
        message: 'Prefer double quotes for string literals.',
      },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.dropped.length, 0);
    assert.equal(report.kept.length, 0);
    assert.equal(report.demoted.length, 1);
    assert.equal(demotedFlag(report.demoted[0]), true);
    // error → high (per severity chain downgrade)
    assert.equal(sev(report.demoted[0]), 'high');
    assert.equal(conf(report.demoted[0]), 'med');
  });
});

// ── 3. Keeps aligned finding ─────────────────────────────────────────────

describe('applyConventionFilter — keep aligned finding', () => {
  it('keeps findings whose message does not contradict any convention', () => {
    const fingerprint = { semicolons: { value: 'always', confidence: 0.9 } };
    const findings = [
      {
        severity: 'warn',
        message: 'Unused variable `x` should be removed.',
      },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.kept.length, 1);
    assert.equal(report.dropped.length, 0);
    assert.equal(report.demoted.length, 0);
  });
});

// ── 4. Empty fingerprint → no changes ────────────────────────────────────

describe('applyConventionFilter — empty fingerprint passes all through', () => {
  it('returns all findings in `kept` when fingerprint has no known keys', () => {
    const fingerprint = {};
    const findings = [
      { severity: 'warn', message: 'Should use semicolons here.' },
      { severity: 'info', message: 'Rename to camelCase.' },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.kept.length, 2);
    assert.equal(report.dropped.length, 0);
    assert.equal(report.demoted.length, 0);
    assert.deepEqual(buildConventionRules(fingerprint), []);
  });

  it('treats null/non-object fingerprints as empty', () => {
    const report = applyConventionFilter(
      [{ severity: 'info', message: 'should use semicolons' }],
      null,
    );
    assert.equal(report.kept.length, 1);
    assert.equal(report.dropped.length, 0);
  });
});

// ── 5. Multiple rules fire for one finding ───────────────────────────────

describe('applyConventionFilter — multiple rules per finding', () => {
  it('drops when any matching rule is a drop, regardless of how many demote', () => {
    const fingerprint = {
      semicolons: { value: 'never', confidence: 0.9 }, // drop
      quotes: { value: 'single', confidence: 0.6 }, // demote
    };
    const findings = [
      {
        severity: 'error',
        // Matches both: "should use semicolons" (drop) and
        // "prefer double quotes" (demote).
        message:
          'Please add semicolons at end of each line, and prefer double quotes for strings.',
      },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.dropped.length, 1);
    assert.equal(report.demoted.length, 0);
    assert.equal(report.kept.length, 0);
    assert.equal(report.dropped[0].rule, 'no-semicolons');
  });

  it('demotes once even when multiple demote rules fire', () => {
    const fingerprint = {
      quotes: { value: 'single', confidence: 0.6 },
      namingCase: { value: 'camelCase', confidence: 0.55 },
    };
    const findings = [
      {
        severity: 'warn',
        message:
          'Please use double quotes and switch to snake_case for these identifiers.',
      },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.demoted.length, 1);
    assert.equal(report.dropped.length, 0);
    assert.equal(demotedFlag(report.demoted[0]), true);
    // warn → medium per severity chain.
    assert.equal(sev(report.demoted[0]), 'medium');
  });
});

// ── 6. Severity downgrade ordering ───────────────────────────────────────

describe('applyConventionFilter — severity downgrade ordering', () => {
  it('follows blocker → high → medium → low → info → nit', () => {
    const fingerprint = { quotes: { value: 'single', confidence: 0.6 } };
    const cases = [
      { input: 'blocker', want: 'high' },
      { input: 'high', want: 'medium' },
      { input: 'medium', want: 'low' },
      { input: 'low', want: 'info' },
      { input: 'info', want: 'nit' },
      { input: 'nit', want: 'nit' }, // floor
    ];
    for (const c of cases) {
      const findings = [
        { severity: c.input, message: 'Switch to double quotes.' },
      ];
      const report = applyConventionFilter(findings, fingerprint);
      assert.equal(report.demoted.length, 1, `expected demote for ${c.input}`);
      assert.equal(
        sev(report.demoted[0]),
        c.want,
        `${c.input} should demote to ${c.want}`,
      );
    }
  });

  it('maps common severity aliases (error→high, warn→medium)', () => {
    const fingerprint = { quotes: { value: 'single', confidence: 0.6 } };
    const findings = [
      { severity: 'error', message: 'Use double quotes.' },
      { severity: 'warn', message: 'Use double quotes.' },
    ];
    const report = applyConventionFilter(findings, fingerprint);
    assert.equal(report.demoted.length, 2);
    assert.equal(sev(report.demoted[0]), 'high');
    assert.equal(sev(report.demoted[1]), 'medium');
  });
});
