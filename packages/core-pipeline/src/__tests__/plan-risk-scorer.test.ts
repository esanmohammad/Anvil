/**
 * Plan v2 risk-scorer tests. Fixtures use the migrator so we exercise
 * the v1→v2 conversion + read the structured `mustTouch[].path` shape
 * the scorer now consumes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scorePlan, computeRiskTier } from '../utils/plan-risk-scorer.js';
import type { Plan } from '../utils/plan-types.js';
import { migratePlanJsonToV2 } from '../plan/migrate.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function basePlan(overrides: Record<string, unknown> = {}): Plan {
  return migratePlanJsonToV2({
    version: 1,
    slug: 'test-plan',
    project: 'proj',
    title: 'Test',
    feature: 'test-feature',
    model: 'test-model',
    ...overrides,
  });
}

function planWithFiles(files: string[], extra: Record<string, unknown> = {}): Plan {
  const plan = basePlan({
    repos: [
      {
        name: 'repo',
        changes: '',
        // migrator promotes string[] → mustTouch[].path
        files,
        symbols: [],
      },
    ],
  });
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
      'src/auth/login.ts',
      'package.json',
      'services/a/index.ts',
      'services/b/index.ts',
      'services/c/index.ts',
    ];
    const score = scorePlan(planWithFiles(files, { confidence: 0.95 }));
    for (let i = 1; i < score.factors.length; i++) {
      assert.ok(
        score.factors[i - 1].weight >= score.factors[i].weight,
        `factor[${i - 1}] (${score.factors[i - 1].weight}) should be >= factor[${i}] (${score.factors[i].weight})`,
      );
    }
    for (const f of score.factors) {
      assert.ok(f.weight > 0.1, `factor ${f.key} has weight ${f.weight} <= 0.1`);
    }
    assert.ok(!score.factors.find((f) => f.key === 'confidence-inverse'));
  });
});
