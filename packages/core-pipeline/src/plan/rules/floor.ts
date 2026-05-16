/**
 * FLOOR rules — minimum semantic quality. A plan whose
 * `problem.statement: ""` passes SHAPE; FLOOR fails it.
 */

import type { Issue, PlanRule } from '../types.js';
import type { Plan } from '../../utils/plan-types.js';

const PROBLEM_MIN = 80;
const WHY_NOW_MIN = 40;

export const problemStatementLengthRule: PlanRule = (plan: Plan): Issue[] => {
  const len = (plan.problem?.statement ?? '').trim().length;
  if (len < PROBLEM_MIN) {
    return [{
      ruleId: 'FLOOR.problem-statement-length',
      severity: 'error',
      path: 'problem.statement',
      message: `Problem statement is ${len} chars; need ≥ ${PROBLEM_MIN} for a verifiable plan.`,
      fixHint: 'Expand: describe who hurts today, what they can\'t do, and what "done" feels like.',
      autoFixable: false,
    }];
  }
  return [];
};

export const problemWhyNowLengthRule: PlanRule = (plan: Plan): Issue[] => {
  const len = (plan.problem?.why_now ?? '').trim().length;
  if (len < WHY_NOW_MIN) {
    return [{
      ruleId: 'FLOOR.problem-why-now-length',
      severity: 'warning',
      path: 'problem.why_now',
      message: `problem.why_now is ${len} chars; need ≥ ${WHY_NOW_MIN}.`,
      fixHint: 'State the trigger: a deadline, a customer escalation, an incident, a strategic bet.',
      autoFixable: false,
    }];
  }
  return [];
};

export const successSignalsNonEmptyRule: PlanRule = (plan: Plan): Issue[] => {
  if (!plan.problem?.success_signals?.length) {
    return [{
      ruleId: 'FLOOR.success-signals-nonempty',
      severity: 'error',
      path: 'problem.success_signals',
      message: 'At least one success signal is required.',
      fixHint: 'Add ≥ 1 observable post-ship signal (metric, support volume drop, etc.).',
      autoFixable: false,
    }];
  }
  return [];
};

export const scopeInScopeNonEmptyRule: PlanRule = (plan: Plan): Issue[] => {
  if (!plan.scope?.inScope?.length) {
    return [{
      ruleId: 'FLOOR.scope-inscope-nonempty',
      severity: 'error',
      path: 'scope.inScope',
      message: 'scope.inScope must contain ≥ 1 item.',
      autoFixable: false,
    }];
  }
  return [];
};

export const reposNonEmptyRule: PlanRule = (plan: Plan): Issue[] => {
  if (!plan.repos?.length) {
    return [{
      ruleId: 'FLOOR.repos-nonempty',
      severity: 'error',
      path: 'repos',
      message: 'Plan must touch ≥ 1 repo.',
      autoFixable: false,
    }];
  }
  return [];
};

export const eachInScopeHasAcceptanceRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < (plan.scope?.inScope?.length ?? 0); i++) {
    const item = plan.scope.inScope[i];
    if (!item.acceptance?.length) {
      issues.push({
        ruleId: 'FLOOR.each-inscope-has-acceptance',
        severity: 'error',
        path: `scope.inScope[${i}].acceptance`,
        message: `Scope item "${item.id || `#${i}`}" must declare ≥ 1 acceptance criterion.`,
        fixHint: 'Add a Gherkin-shaped line: "Given …, when …, then …".',
        autoFixable: false,
      });
    }
  }
  return issues;
};

export const reposHaveChangesNarrativeRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < (plan.repos?.length ?? 0); i++) {
    const r = plan.repos[i];
    if (!r.changes || r.changes.trim().length < 20) {
      issues.push({
        ruleId: 'FLOOR.repo-has-changes-narrative',
        severity: 'warning',
        path: `repos[${i}].changes`,
        message: `repos[${i}].changes ("${r.name}") is missing or < 20 chars.`,
        autoFixable: false,
      });
    }
  }
  return issues;
};
