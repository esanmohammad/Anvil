/**
 * Tests for plan-risk-scorer.
 *
 * Uses node:test + node:assert (built-in runner), matching the style of the
 * other tests in this directory. Run via:
 *   node --test packages/dashboard/server/__tests__/plan-risk-scorer.test.ts
 * (after tsc compile, or via a ts loader).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scorePlan, computeRiskTier } from '../plan-risk-scorer.js';
import type { Plan } from '../plan-store.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function basePlan(overrides: Partial<Plan> = {}): Plan {
  const now = new Date().toISOString();
  const plan: Plan = {
    version: 1,
    slug: 'test-plan',
    project: 'proj',
    title: 'Test',
    problem: 'n/a',
    scope: { inScope: [], outOfScope: [] },
    repos: [],
    contracts: [],
    architecture: { mermaid: '', notes: '' },
    risks: [],
    rollout: { strategy: '', flags: [], order: [], rollback: '' },
    tests: { unit: [], integration: [], manual: [] },
    estimate: { usd: 0, minutes: 0, prs: 0 },
    model: 'test-model',
    feature: 'test-feature',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return plan;
}

function planWithFiles(files: string[], extra: Record<string, unknown> = {}): Plan {
  const plan = basePlan({
    repos: [
      {
        name: 'repo',
        changes: '',
        files,
        symbols: [],
      },
    ],
  });
  // Attach optional fields the scorer reads (confidence, scopeBoundaryRisks).
  return Object.assign(plan, extra) as Plan;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('computeRiskTier', () => {
  it('maps overall to tier thresholds', () => {
    assert.equal(computeRiskTier(0), 'low');
    assert.equal(computeRiskTier(0.29), 'low');
    assert.equal(computeRiskTier(0.3), 'med');
    assert.equal(computeRiskTier(0.64), 'med');
    assert.equal(computeRiskTier(0.65), 'high');
    assert.equal(computeRiskTier(1), 'high');
  });
});

describe('scorePlan', () => {
  it('empty plan scores ~0 and is tier low', () => {
    // Default confidence is 0.5 => confidence-inverse = 0.25 (kept, but <0.3).
    const score = scorePlan(basePlan());
    assert.equal(score.tier, 'low');
    assert.ok(score.overall < 0.3, `expected <0.3, got ${score.overall}`);
    assert.equal(score.scorerVersion, '1.0.0');
  });

  it('touching an auth/ file bumps tier to at least med', () => {
    const score = scorePlan(planWithFiles(['src/auth/login.ts']));
    assert.notEqual(score.tier, 'low');
    const sensitive = score.factors.find((f) => f.key === 'sensitive-paths');
    assert.ok(sensitive, 'sensitive-paths factor should be present');
    assert.ok(sensitive!.weight >= 0.8);
  });

  it('migrations + many files yields tier high', () => {
    const files: string[] = [];
    for (let i = 0; i < 30; i++) files.push(`src/feature/file-${i}.ts`);
    files.push('db/migrations/2026_04_add_table.sql');
    const score = scorePlan(planWithFiles(files));
    assert.equal(score.tier, 'high');
    assert.ok(score.overall >= 0.65);
  });

  it('low confidence (0.2) increases score vs default', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const baseline = scorePlan(planWithFiles(files));
    const lowConf = scorePlan(planWithFiles(files, { confidence: 0.2 }));
    assert.ok(
      lowConf.overall > baseline.overall,
      `expected lowConf>${baseline.overall}, got ${lowConf.overall}`,
    );
    const cf = lowConf.factors.find((f) => f.key === 'confidence-inverse');
    assert.ok(cf, 'confidence-inverse factor should surface');
    assert.equal(lowConf.confidence, 0.2);
  });

  it('surfaces scopeBoundaryRisks from the plan', () => {
    const risks = ['leaks into billing', 'couples auth to payments'];
    const plan = planWithFiles(['src/x.ts'], { scopeBoundaryRisks: risks });
    const score = scorePlan(plan);
    assert.deepEqual(score.scopeBoundaryRisks, risks);
  });

  it('factors are ordered desc by weight and filter out <=0.1', () => {
    const files = [
      'src/auth/login.ts',           // sensitive-paths high
      'package.json',                // new-dependency 0.6
      'services/a/index.ts',
      'services/b/index.ts',
      'services/c/index.ts',         // cross-package
    ];
    const score = scorePlan(planWithFiles(files, { confidence: 0.95 }));
    // Sorted descending
    for (let i = 1; i < score.factors.length; i++) {
      assert.ok(
        score.factors[i - 1].weight >= score.factors[i].weight,
        `factor[${i - 1}] (${score.factors[i - 1].weight}) should be >= factor[${i}] (${score.factors[i].weight})`,
      );
    }
    // All kept factors must be > 0.1
    for (const f of score.factors) {
      assert.ok(f.weight > 0.1, `factor ${f.key} has weight ${f.weight} <= 0.1`);
    }
    // High confidence (0.95) means confidence-inverse would be ~0.025 -> filtered out.
    assert.ok(!score.factors.find((f) => f.key === 'confidence-inverse'));
  });
});
