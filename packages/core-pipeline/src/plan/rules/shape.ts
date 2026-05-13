/**
 * SHAPE rules — every required v2 field is present and typed correctly.
 *
 * These don't replace TypeScript's type-system — the plan agent emits
 * JSON, and JSON is untyped at runtime. The migrator stubs missing
 * fields, but a stub like `problem.statement: ""` still needs to be
 * surfaced as an issue.
 */

import type { Issue, PlanRule } from '../types.js';
import type { Plan } from '../../utils/plan-types.js';

export const requiredFieldsPresentRule: PlanRule = (plan: Plan): Issue[] => {
  const issues: Issue[] = [];
  const requiredTop: Array<keyof Plan> = [
    'slug', 'project', 'title', 'feature', 'model', 'problem', 'scope',
    'repos', 'contracts', 'data', 'observability', 'architecture',
    'risks', 'rollout', 'tests', 'estimate',
  ];
  for (const k of requiredTop) {
    if (plan[k] === undefined || plan[k] === null) {
      issues.push({
        ruleId: 'SHAPE.required-fields-present',
        severity: 'error',
        path: String(k),
        message: `Required field "${String(k)}" missing.`,
        autoFixable: false,
      });
    }
  }
  return issues;
};

export const schemaDiscriminatorRule: PlanRule = (plan: Plan): Issue[] => {
  if (plan.schema !== 2) {
    return [{
      ruleId: 'SHAPE.schema-discriminator',
      severity: 'error',
      path: 'schema',
      message: `Plan.schema must be 2 (canonical v2); got ${String(plan.schema)}.`,
      autoFixable: true,
      autoFixSuggestion: { kind: 'set-field', path: 'schema', value: 2 },
    }];
  }
  return [];
};

export const contentHashPresentRule: PlanRule = (plan: Plan): Issue[] => {
  if (typeof plan.contentHash !== 'string' || plan.contentHash.length < 12) {
    return [{
      ruleId: 'SHAPE.content-hash-present',
      severity: 'warning',
      path: 'contentHash',
      message: 'Plan should carry a contentHash; it gets recomputed on save.',
      autoFixable: false,
      fixHint: 'Re-save the plan via PlanStore.bumpVersion to stamp a fresh hash.',
    }];
  }
  return [];
};
