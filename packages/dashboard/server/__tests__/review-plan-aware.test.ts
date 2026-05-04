/**
 * Tests for review-plan-aware — PRPlanComparison → PlanAwareFinding mapping.
 *
 * Uses node:test + node:assert (built-in runner). No explicit TS type
 * annotations inside the test bodies (per module contract).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { producePlanAwareFindings } from '../review-plan-aware.js';
import type { PRPlanComparison } from '../review-plan-diff-comparator.js';

function makeComparison(overrides: Partial<PRPlanComparison> = {}): PRPlanComparison {
  return {
    totalSteps: 0,
    matchedSteps: 0,
    missingSteps: [],
    unexpectedFiles: [],
    scopeCreepSeverity: 'none',
    ...overrides,
  };
}

describe('producePlanAwareFindings', () => {
  it('emits a single plan-ok finding when all steps are matched and nothing is unexpected', () => {
    const comparison = makeComparison({
      totalSteps: 3,
      matchedSteps: 3,
      missingSteps: [],
      unexpectedFiles: [],
      scopeCreepSeverity: 'none',
    });

    const findings = producePlanAwareFindings(comparison);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'plan-ok');
    assert.equal(findings[0].severity, 'low');
    assert.match(findings[0].message, /3\/3/);
  });

  it('emits one missing-deliverable finding per missing step (severity medium)', () => {
    const comparison = makeComparison({
      totalSteps: 3,
      matchedSteps: 1,
      missingSteps: [
        {
          stepId: 'repos[0].files[1]',
          description: 'Add caching layer to user service',
          matchedFiles: [],
          matchedConfidence: 0.05,
          missing: true,
        },
        {
          stepId: 'tests.unit[0]',
          description: 'Unit tests for cache invalidation',
          matchedFiles: [],
          matchedConfidence: 0,
          missing: true,
        },
      ],
      unexpectedFiles: [],
      scopeCreepSeverity: 'none',
    });

    const findings = producePlanAwareFindings(comparison);

    assert.equal(findings.length, 2);
    for (const f of findings) {
      assert.equal(f.kind, 'missing-deliverable');
      assert.equal(f.severity, 'medium');
      assert.ok(f.planStepId);
      assert.ok(f.evidence && f.evidence.length > 0);
    }
    // Evidence preserves step description, with no user-visible plan-ok.
    assert.ok(findings.some((f) => f.planStepId === 'repos[0].files[1]'));
    assert.ok(findings.some((f) => f.planStepId === 'tests.unit[0]'));
    assert.ok(!findings.some((f) => f.kind === 'plan-ok'));
  });

  it('emits one scope-creep finding per unexpected file (non-sensitive paths)', () => {
    const comparison = makeComparison({
      totalSteps: 2,
      matchedSteps: 2,
      missingSteps: [],
      unexpectedFiles: ['src/analytics/tracker.ts', 'docs/changelog.md'],
      scopeCreepSeverity: 'medium',
    });

    const findings = producePlanAwareFindings(comparison);

    assert.equal(findings.length, 2);
    for (const f of findings) {
      assert.equal(f.kind, 'scope-creep');
    }
    const paths = findings.map((f) => f.filePath);
    assert.ok(paths.includes('src/analytics/tracker.ts'));
    assert.ok(paths.includes('docs/changelog.md'));
    // medium tier on a non-sensitive file stays medium.
    for (const f of findings) {
      assert.equal(f.severity, 'medium');
    }
  });

  it('escalates scope-creep to blocker when the file touches a sensitive path', () => {
    const comparison = makeComparison({
      totalSteps: 1,
      matchedSteps: 1,
      missingSteps: [],
      unexpectedFiles: ['src/auth/session.ts', 'db/migrations/2026_04_add_role.sql', 'README.md'],
      scopeCreepSeverity: 'high',
    });

    const findings = producePlanAwareFindings(comparison);

    assert.equal(findings.length, 3);
    const bySeverity = Object.fromEntries(
      findings.map((f) => [f.filePath, f.severity]),
    );
    assert.equal(bySeverity['src/auth/session.ts'], 'blocker');
    assert.equal(bySeverity['db/migrations/2026_04_add_role.sql'], 'blocker');
    // Non-sensitive file with a 'high' tier stays 'high'.
    assert.equal(bySeverity['README.md'], 'high');
  });

  it('emits no findings when the plan is empty and the diff is empty', () => {
    const comparison = makeComparison({
      totalSteps: 0,
      matchedSteps: 0,
      missingSteps: [],
      unexpectedFiles: [],
      scopeCreepSeverity: 'none',
    });

    const findings = producePlanAwareFindings(comparison);

    assert.equal(findings.length, 0);
  });
});
