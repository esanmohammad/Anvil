/**
 * Plan auto-refine — applies the deterministic patches surfaced by
 * the rule engine and confirms a re-validation pass surfaces fewer
 * issues than the input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runPlanRules } from '../plan/run-rules.js';
import { autoRefinePlan } from '../plan/auto-refine.js';
import { migratePlanJsonToV2 } from '../plan/migrate.js';
import type { Plan } from '../utils/plan-types.js';
import type { RuleContext } from '../plan/types.js';

function ctx(): RuleContext {
  return { project: 'proj', projectRepos: ['web'], kbFiles: {}, kbSymbols: {} };
}

describe('autoRefinePlan', () => {
  it('patches CONTRACT.http-status-codes-valid auto-fixable issue', () => {
    const plan: Plan = migratePlanJsonToV2({
      version: 1,
      slug: 'x',
      project: 'proj',
      title: 'X',
      feature: 'X',
      model: 'sonnet',
      problem:
        'This problem statement is well over eighty characters so that the FLOOR rule on length will stay silent during these tests.',
      scope: { inScope: [{ id: 's1', description: 'thing', acceptance: ['it works'] }], outOfScope: [] },
      repos: [{ name: 'web', changes: 'doing the thing', files: ['a.ts'] }],
      contracts: [
        {
          kind: 'http',
          method: 'GET',
          path: '/foo',
          producer: 'web',
          consumers: [],
          status: [], // ← rule fires + auto-fixes to [200]
        },
      ],
      risks: [],
      rollout: { strategy: 'direct', flags: [], order: [], rollback: 'flag off' },
      tests: { unit: [], integration: [], manual: [] },
      estimate: { usd: 1, minutes: 10, prs: 1 },
    });

    const before = runPlanRules(plan, ctx());
    assert.ok(before.issues.some((i) => i.ruleId === 'CONTRACT.http-status-codes-valid'));

    const outcome = autoRefinePlan(plan, before);
    assert.ok(outcome.changes >= 1);
    assert.deepEqual((outcome.plan.contracts[0] as { status: number[] }).status, [200]);

    const after = runPlanRules(outcome.plan, ctx());
    const stillFires = after.issues.some((i) => i.ruleId === 'CONTRACT.http-status-codes-valid');
    assert.equal(stillFires, false);
  });

  it('drops approval when patches are applied', () => {
    const plan: Plan = migratePlanJsonToV2({
      version: 1,
      slug: 'x',
      project: 'proj',
      title: 'X',
      feature: 'X',
      model: 'sonnet',
      problem:
        'This problem statement is well over eighty characters so that the FLOOR rule on length will stay silent during these tests.',
      scope: { inScope: [{ id: 's1', description: 'thing', acceptance: ['it works'] }], outOfScope: [] },
      repos: [{ name: 'web', changes: 'doing the thing', files: ['a.ts'] }],
      contracts: [{
        kind: 'http', method: 'GET', path: '/foo', producer: 'web', consumers: [], status: [],
      }],
      risks: [],
      rollout: { strategy: 'direct', flags: [], order: [], rollback: 'flag off' },
      tests: { unit: [], integration: [], manual: [] },
      estimate: { usd: 1, minutes: 10, prs: 1 },
    });
    plan.approval = {
      user: 'tester',
      approvedAt: '2026-01-01T00:00:00Z',
      planHash: plan.contentHash,
    };

    const before = runPlanRules(plan, ctx());
    const outcome = autoRefinePlan(plan, before);
    assert.ok(outcome.changes >= 1);
    assert.equal(outcome.plan.approval, undefined);
  });

  it('returns plan unchanged when nothing is auto-fixable', () => {
    const plan: Plan = migratePlanJsonToV2({
      version: 1, slug: 'x', project: 'proj', title: 'X', feature: 'X', model: 'sonnet',
      problem: 'short',
      scope: { inScope: [], outOfScope: [] },
      repos: [],
      contracts: [], risks: [],
      rollout: { strategy: 'direct', flags: [], order: [], rollback: '' },
      tests: { unit: [], integration: [], manual: [] },
      estimate: { usd: 0, minutes: 0, prs: 0 },
    });
    const before = runPlanRules(plan, ctx());
    const outcome = autoRefinePlan(plan, before);
    assert.equal(outcome.changes, 0);
    // Issues are non-auto-fixable so all flow to `remaining`.
    assert.ok(outcome.remaining.length > 0);
  });
});
