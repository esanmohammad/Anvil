/**
 * DATA / TESTS / RISK / BUDGET rules.
 *
 * One file per category got noisy for these four — they're each a
 * handful of small rules around one structural area. Kept together
 * to minimize the import barrel.
 */

import type { Issue, PlanRule } from '../types.js';
import type { Plan, DataChange } from '../../utils/plan-types.js';

// ── DATA ─────────────────────────────────────────────────────────────────

export const dataMigrationPresentRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  // Any db contract introduces a table → expect a migration for it.
  const dbTables = plan.contracts
    .filter((c) => c.kind === 'db')
    .map((c) => (c.kind === 'db' ? c.table : ''))
    .filter(Boolean);
  for (const table of dbTables) {
    const hasMigration = plan.data.some(
      (d): d is DataChange => d.kind === 'migration' && d.migrationFile.toLowerCase().includes(table.toLowerCase()),
    );
    if (!hasMigration) {
      issues.push({
        ruleId: 'DATA.migration-present-for-table-create',
        severity: 'warning',
        path: 'data',
        message: `db contract for table "${table}" has no matching migration in data[].`,
        fixHint: `Add a data[] entry with kind:"migration" and migrationFile mentioning "${table}".`,
        autoFixable: false,
      });
    }
  }
  return issues;
};

export const dataRollbackPresentRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < plan.data.length; i++) {
    const d = plan.data[i];
    if (!d.rollback || d.rollback.trim().length === 0) {
      issues.push({
        ruleId: 'DATA.rollback-present-for-each-migration',
        severity: 'error',
        path: `data[${i}].rollback`,
        message: `data[${i}] (${d.kind}) is missing a rollback.`,
        fixHint: 'Add the SQL/command that undoes this change; if irreversible, document why.',
        autoFixable: false,
      });
    }
  }
  return issues;
};

export const dataDropFlaggedHighRiskRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  const hasDrop = plan.data.some((d) => d.kind === 'drop');
  if (!hasDrop) return [];
  const hasHighDataLossRisk = plan.risks.some(
    (r) => r.severity === 'high' && r.blastRadius === 'data-loss',
  );
  if (!hasHighDataLossRisk) {
    issues.push({
      ruleId: 'DATA.drop-flagged-as-high-risk',
      severity: 'error',
      path: 'risks',
      message: 'data[] contains a drop but no high-severity data-loss risk is declared.',
      fixHint: 'Add a Risk with severity:"high", blastRadius:"data-loss".',
      autoFixable: false,
    });
  }
  return issues;
};

// ── TESTS ────────────────────────────────────────────────────────────────

export const acceptanceHasTestRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  const refs = new Set(
    [...plan.tests.unit, ...plan.tests.integration].map((t) => t.acceptanceRef),
  );
  for (let i = 0; i < plan.scope.inScope.length; i++) {
    const item = plan.scope.inScope[i];
    for (let j = 0; j < item.acceptance.length; j++) {
      // Acceptance criteria are referenced by `${item.id}:${j}` or by
      // a stable acceptance id when the writer supplies one. We accept
      // either match shape — `refs` contains acceptanceRef strings.
      const idMatch = refs.has(item.id) || refs.has(`${item.id}.${j}`) || refs.has(`${item.id}:${j}`);
      if (!idMatch) {
        issues.push({
          ruleId: 'TESTS.acceptance-has-test',
          severity: 'warning',
          path: `scope.inScope[${i}].acceptance[${j}]`,
          message: `Acceptance "${item.acceptance[j].slice(0, 60)}…" has no TestCaseSpec referencing "${item.id}".`,
          fixHint: `Add a TestCaseSpec with acceptanceRef:"${item.id}".`,
          autoFixable: false,
        });
      }
    }
  }
  return issues;
};

export const testCaseFieldsRequiredRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  const all = [
    ...plan.tests.unit.map((t, i) => ({ t, bucket: 'unit' as const, i })),
    ...plan.tests.integration.map((t, i) => ({ t, bucket: 'integration' as const, i })),
  ];
  for (const { t, bucket, i } of all) {
    if (!t.file) {
      issues.push({
        ruleId: 'TESTS.fields-required',
        severity: 'error',
        path: `tests.${bucket}[${i}].file`,
        message: `TestCaseSpec must declare a target file.`,
        autoFixable: false,
      });
    }
    if (!t.name) {
      issues.push({
        ruleId: 'TESTS.fields-required',
        severity: 'error',
        path: `tests.${bucket}[${i}].name`,
        message: `TestCaseSpec must declare a test function name.`,
        autoFixable: false,
      });
    }
  }
  return issues;
};

// ── RISK ─────────────────────────────────────────────────────────────────

export const authChangesFlaggedRule: PlanRule = (plan: Plan): Issue[] => {
  const touchesAuth = plan.repos.some((r) =>
    [...r.mustTouch, ...r.mustExist].some((f) => /auth|session|token|jwt|oauth/i.test(f.path)),
  );
  if (!touchesAuth) return [];
  const hasAuthRisk = plan.risks.some((r) => r.blastRadius === 'auth-bypass');
  if (hasAuthRisk) return [];
  return [{
    ruleId: 'RISK.auth-changes-flagged',
    severity: 'error',
    path: 'risks',
    message: 'Plan touches auth/session paths but has no Risk with blastRadius:"auth-bypass".',
    fixHint: 'Add a Risk{ blastRadius:"auth-bypass", severity:"high", … }.',
    autoFixable: false,
  }];
};

export const highBlastRadiusHasRollbackRule: PlanRule = (plan: Plan): Issue[] => {
  const hasHigh = plan.risks.some((r) => r.severity === 'high');
  if (!hasHigh) return [];
  if (!plan.rollout?.rollback?.command) {
    return [{
      ruleId: 'RISK.high-blast-radius-has-rollback',
      severity: 'error',
      path: 'rollout.rollback.command',
      message: 'Plan has high-severity risks but no rollback command.',
      autoFixable: false,
    }];
  }
  return [];
};

// ── BUDGET ───────────────────────────────────────────────────────────────

export const estimatePrsMatchesReposRule: PlanRule = (plan: Plan): Issue[] => {
  const touched = plan.repos.filter((r) => r.mustTouch.length + r.mustExist.length > 0).length;
  if (touched > 0 && plan.estimate.prs < touched) {
    return [{
      ruleId: 'BUDGET.estimate-prs-matches-repos-touched',
      severity: 'warning',
      path: 'estimate.prs',
      message: `estimate.prs is ${plan.estimate.prs} but ${touched} repo(s) get touched — expect ≥ ${touched} PRs.`,
      autoFixable: true,
      autoFixSuggestion: { kind: 'set-field', path: 'estimate.prs', value: touched },
    }];
  }
  return [];
};

export const estimateWithinSimilarRule: PlanRule = (plan: Plan, ctx): Issue[] => {
  const median = ctx.budget?.medianUsdPerSimilarPlan;
  if (median == null || median <= 0) return [];
  const usd = plan.estimate.usd;
  if (usd > median * 2) {
    return [{
      ruleId: 'BUDGET.estimate-within-2x-of-similar',
      severity: 'warning',
      path: 'estimate.usd',
      message: `estimate.usd=$${usd.toFixed(2)} is > 2× the median of similar plans ($${median.toFixed(2)}).`,
      fixHint: 'Either scope down, split into smaller plans, or document why this run is bigger.',
      autoFixable: false,
    }];
  }
  return [];
};
