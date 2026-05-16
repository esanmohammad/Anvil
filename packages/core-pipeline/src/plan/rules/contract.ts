/**
 * CONTRACT rules — every cross-repo contract has a producer and
 * consumers among the plan's repos, and is well-formed.
 */

import type { Issue, PlanRule } from '../types.js';
import type { Plan, PlanContract } from '../../utils/plan-types.js';

function planRepoNames(plan: Plan): string[] {
  return plan.repos.map((r) => r.name);
}

export const contractProducerKnownRule: PlanRule = (plan: Plan): Issue[] => {
  const names = planRepoNames(plan);
  const issues: Issue[] = [];
  for (let i = 0; i < plan.contracts.length; i++) {
    const c = plan.contracts[i];
    if (!c.producer) {
      issues.push({
        ruleId: 'CONTRACT.producer-required',
        severity: 'error',
        path: `contracts[${i}].producer`,
        message: `${c.kind} contract is missing a producer repo.`,
        autoFixable: false,
      });
      continue;
    }
    if (!names.includes(c.producer)) {
      issues.push({
        ruleId: 'CONTRACT.producer-is-known-repo',
        severity: 'error',
        path: `contracts[${i}].producer`,
        message: `Producer "${c.producer}" is not in the plan's repos[].`,
        fixHint: `Add "${c.producer}" to repos[] or change producer to one of: ${names.join(', ')}.`,
        autoFixable: false,
      });
    }
  }
  return issues;
};

export const contractConsumersKnownRule: PlanRule = (plan: Plan): Issue[] => {
  const names = planRepoNames(plan);
  const issues: Issue[] = [];
  for (let i = 0; i < plan.contracts.length; i++) {
    const c = plan.contracts[i];
    // db contracts have only a producer (the owner) and no consumers.
    if (c.kind === 'db') continue;
    for (let j = 0; j < c.consumers.length; j++) {
      const con = c.consumers[j];
      if (!names.includes(con)) {
        issues.push({
          ruleId: 'CONTRACT.consumers-are-known-repos',
          severity: 'warning',
          path: `contracts[${i}].consumers[${j}]`,
          message: `Consumer "${con}" of contract is not in the plan's repos[].`,
          autoFixable: false,
        });
      }
    }
  }
  return issues;
};

function isHttpContract(c: PlanContract): c is Extract<PlanContract, { kind: 'http' }> {
  return c.kind === 'http';
}

export const httpPathFormatRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < plan.contracts.length; i++) {
    const c = plan.contracts[i];
    if (!isHttpContract(c)) continue;
    if (!c.path || !c.path.startsWith('/')) {
      issues.push({
        ruleId: 'CONTRACT.http-path-format',
        severity: 'error',
        path: `contracts[${i}].path`,
        message: `HTTP contract path "${c.path}" must start with "/".`,
        autoFixable: false,
      });
      continue;
    }
    const opens = (c.path.match(/{/g) ?? []).length;
    const closes = (c.path.match(/}/g) ?? []).length;
    if (opens !== closes) {
      issues.push({
        ruleId: 'CONTRACT.http-path-format',
        severity: 'error',
        path: `contracts[${i}].path`,
        message: `Path "${c.path}" has unbalanced curly braces.`,
        autoFixable: false,
      });
    }
  }
  return issues;
};

export const httpStatusCodesValidRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  for (let i = 0; i < plan.contracts.length; i++) {
    const c = plan.contracts[i];
    if (!isHttpContract(c)) continue;
    if (!c.status?.length) {
      issues.push({
        ruleId: 'CONTRACT.http-status-codes-valid',
        severity: 'error',
        path: `contracts[${i}].status`,
        message: 'HTTP contract must declare ≥ 1 status code.',
        autoFixable: true,
        autoFixSuggestion: { kind: 'set-field', path: `contracts[${i}].status`, value: [200] },
      });
      continue;
    }
    for (let j = 0; j < c.status.length; j++) {
      const s = c.status[j];
      if (typeof s !== 'number' || s < 100 || s > 599) {
        issues.push({
          ruleId: 'CONTRACT.http-status-codes-valid',
          severity: 'error',
          path: `contracts[${i}].status[${j}]`,
          message: `Status ${s} is outside 100–599.`,
          autoFixable: false,
        });
      }
    }
  }
  return issues;
};
