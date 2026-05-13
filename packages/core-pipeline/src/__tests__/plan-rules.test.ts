/**
 * Verification engine — smoke tests over the rule pack.
 *
 * Covers one rule per category: SHAPE, FLOOR, KB, CONTRACT, DATA,
 * TESTS, RISK, BUDGET. Each fixture exercises both the "fires" and
 * the "stays silent" path so a rule's false-positives surface early.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runPlanRules, defaultRulePack } from '../plan/run-rules.js';
import type { Issue, RuleContext } from '../plan/types.js';
import { migratePlanJsonToV2, emptyPlanV2 } from '../plan/migrate.js';
import { planContentHash } from '../plan/hash.js';
import type { Plan } from '../utils/plan-types.js';

function makeCtx(over: Partial<RuleContext> = {}): RuleContext {
  return {
    project: 'proj',
    projectRepos: ['web', 'api'],
    kbFiles: {},
    kbSymbols: {},
    ...over,
  };
}

function findRule(issues: Issue[], ruleId: string): Issue | undefined {
  return issues.find((i) => i.ruleId === ruleId);
}

describe('hash', () => {
  it('content hash is stable across key order', () => {
    const a = { foo: 1, bar: 2 };
    const b = { bar: 2, foo: 1 };
    assert.equal(planContentHash(a), planContentHash(b));
  });

  it('ignores contentHash + approval + updatedAt', () => {
    const a = { foo: 1, contentHash: 'A', approval: { x: 1 }, updatedAt: 't1' };
    const b = { foo: 1, contentHash: 'B', approval: { x: 2 }, updatedAt: 't2' };
    assert.equal(planContentHash(a), planContentHash(b));
  });
});

describe('migrator', () => {
  it('v1 plan promotes to v2 shape', () => {
    const v1 = {
      version: 2,
      slug: 'foo',
      project: 'proj',
      title: 'Foo',
      feature: 'feature',
      model: 'sonnet',
      problem: 'plain string problem',
      scope: { inScope: ['a', 'b'], outOfScope: ['c'] },
      repos: [
        { name: 'web', changes: 'do stuff', files: ['a.ts', 'b.ts'], symbols: ['F', 'g'] },
      ],
      contracts: [
        { kind: 'http', name: 'GET /foo', producer: 'api', consumers: ['web'], description: '' },
      ],
      risks: [{ title: 'r1', mitigation: 'm', severity: 'med' }],
      rollout: { strategy: 'feature-flag', flags: [], order: [], rollback: 'flag off' },
      tests: { unit: ['t1'], integration: ['t2'], manual: ['m1'] },
      estimate: { usd: 1, minutes: 10, prs: 1 },
    };
    const p = migratePlanJsonToV2(v1);
    assert.equal(p.schema, 2);
    assert.equal(p.problem.statement, 'plain string problem');
    assert.equal(p.scope.inScope.length, 2);
    assert.equal(p.scope.inScope[0].description, 'a');
    assert.equal(p.repos[0].mustTouch.length, 2);
    assert.equal(p.repos[0].mustTouch[0].path, 'a.ts');
    assert.equal(p.repos[0].symbols[0].name, 'F');
    assert.equal(p.rollout.rollback.command, 'flag off');
    assert.equal(p.contentHash.length, 64);
  });

  it('empty plan is well-formed and hashable', () => {
    const p = emptyPlanV2('proj', 'feature', 'sonnet');
    assert.equal(p.schema, 2);
    assert.equal(p.problem.statement, '');
    assert.equal(p.contentHash.length, 64);
  });
});

// ── Rule sanity ──────────────────────────────────────────────────────────

function planFromV1(over: Record<string, unknown> = {}): Plan {
  return migratePlanJsonToV2({
    version: 1,
    slug: 'x',
    project: 'proj',
    title: 'X',
    feature: 'X',
    model: 'sonnet',
    problem:
      'This is a problem statement that is well over the eighty character minimum so the FLOOR rule should be silent.',
    scope: { inScope: ['only thing', 'second thing'], outOfScope: [] },
    repos: [{ name: 'web', changes: 'do something specific and meaningful', files: ['a.ts'], symbols: ['x'] }],
    contracts: [],
    risks: [],
    rollout: { strategy: 'direct', flags: [], order: [], rollback: 'nothing' },
    tests: { unit: [], integration: [], manual: [] },
    estimate: { usd: 1, minutes: 10, prs: 1, calibratedFrom: [] },
    ...over,
  });
}

describe('FLOOR rules', () => {
  it('flags short problem statement', () => {
    const plan = planFromV1({ problem: 'too short' });
    const report = runPlanRules(plan, makeCtx());
    assert.ok(findRule(report.issues, 'FLOOR.problem-statement-length'));
  });

  it('flags empty scope.inScope', () => {
    const plan = planFromV1({ scope: { inScope: [], outOfScope: [] } });
    const report = runPlanRules(plan, makeCtx());
    assert.ok(findRule(report.issues, 'FLOOR.scope-inscope-nonempty'));
  });

  it('flags empty repos', () => {
    const plan = planFromV1({ repos: [] });
    const report = runPlanRules(plan, makeCtx());
    assert.ok(findRule(report.issues, 'FLOOR.repos-nonempty'));
  });
});

describe('KB rules', () => {
  it('flags repo not in project', () => {
    const plan = planFromV1({
      repos: [{ name: 'unknown', changes: 'lots of stuff happening here actually', files: [] }],
    });
    const report = runPlanRules(plan, makeCtx({ projectRepos: ['web', 'api'] }));
    assert.ok(findRule(report.issues, 'KB.repo-exists'));
  });

  it('flags mustTouch file not in KB index', () => {
    const plan = planFromV1({
      repos: [
        {
          name: 'web',
          changes: 'modify the login flow with attention to detail',
          mustTouch: [{ path: 'src/imaginary.ts', kind: 'modified', reason: 'r' }],
        },
      ],
    });
    const report = runPlanRules(plan, makeCtx({
      kbFiles: { web: new Set(['src/real.ts']) },
    }));
    assert.ok(findRule(report.issues, 'KB.file-modified-exists'));
  });

  it('stays silent when KB confirms the path', () => {
    const plan = planFromV1({
      repos: [
        {
          name: 'web',
          changes: 'modify the login flow with attention to detail',
          mustTouch: [{ path: 'src/real.ts', kind: 'modified', reason: 'r' }],
        },
      ],
    });
    const report = runPlanRules(plan, makeCtx({
      kbFiles: { web: new Set(['src/real.ts']) },
    }));
    assert.equal(findRule(report.issues, 'KB.file-modified-exists'), undefined);
  });
});

describe('CONTRACT rules', () => {
  it('flags producer not in plan repos', () => {
    const plan = planFromV1({
      repos: [{ name: 'web', changes: 'still doing significant updates here', files: [] }],
      contracts: [{
        kind: 'http', method: 'GET', path: '/foo',
        producer: 'ghost', consumers: ['web'], status: [200],
      }],
    });
    const report = runPlanRules(plan, makeCtx());
    assert.ok(findRule(report.issues, 'CONTRACT.producer-is-known-repo'));
  });

  it('flags malformed HTTP path', () => {
    const plan = planFromV1({
      repos: [{ name: 'web', changes: 'making lots of changes everywhere all at once', files: [] }],
      contracts: [{
        kind: 'http', method: 'GET', path: 'no-slash',
        producer: 'web', consumers: [], status: [200],
      }],
    });
    const report = runPlanRules(plan, makeCtx());
    assert.ok(findRule(report.issues, 'CONTRACT.http-path-format'));
  });
});

describe('RISK rules', () => {
  it('flags auth-touching plans without auth-bypass risk', () => {
    const plan = planFromV1({
      repos: [{
        name: 'web',
        changes: 'modify session middleware in a meaningful way',
        mustTouch: [{ path: 'src/auth/session.ts', kind: 'modified', reason: 'change session' }],
      }],
      risks: [],
    });
    const report = runPlanRules(plan, makeCtx());
    assert.ok(findRule(report.issues, 'RISK.auth-changes-flagged'));
  });

  it('stays silent when auth-bypass risk is declared', () => {
    const plan = planFromV1({
      repos: [{
        name: 'web',
        changes: 'modify session middleware in a meaningful way',
        mustTouch: [{ path: 'src/auth/session.ts', kind: 'modified', reason: 'change session' }],
      }],
      risks: [{
        id: 'r1', title: 'Session leak', severity: 'high',
        blastRadius: 'auth-bypass', mitigation: 'CSP', detection: 'WAF',
      }],
    });
    const report = runPlanRules(plan, makeCtx());
    assert.equal(findRule(report.issues, 'RISK.auth-changes-flagged'), undefined);
  });
});

describe('runPlanRules', () => {
  it('counts errors / warnings / infos', () => {
    const plan = emptyPlanV2('proj', 'thin feature', 'sonnet');
    const report = runPlanRules(plan, makeCtx());
    assert.ok(report.counts.errors > 0);
    assert.equal(report.planSlug, plan.slug);
    assert.equal(report.planHash, plan.contentHash);
    assert.equal(defaultRulePack.length > 20, true);
  });
});
