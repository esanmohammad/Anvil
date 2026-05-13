/**
 * Rule-pack runner — executes every rule in `defaultRulePack` (or a
 * caller-supplied pack) and produces a `PlanValidationReport`.
 *
 * Replaces the old shape-only `PlanValidator` in dashboard/server/.
 * The dashboard adapter (`plan-validator-bridge.ts`) wraps this and
 * supplies the KB-grounded RuleContext.
 */

import type { Plan } from '../utils/plan-types.js';
import type { Issue, PlanRule, RuleContext } from './types.js';

import {
  requiredFieldsPresentRule,
  schemaDiscriminatorRule,
  contentHashPresentRule,
} from './rules/shape.js';
import {
  problemStatementLengthRule,
  problemWhyNowLengthRule,
  successSignalsNonEmptyRule,
  scopeInScopeNonEmptyRule,
  reposNonEmptyRule,
  eachInScopeHasAcceptanceRule,
  reposHaveChangesNarrativeRule,
} from './rules/floor.js';
import {
  repoExistsRule,
  fileModifiedExistsRule,
  fileNewParentExistsRule,
  symbolModifiedExistsRule,
} from './rules/kb-grounding.js';
import {
  contractProducerKnownRule,
  contractConsumersKnownRule,
  httpPathFormatRule,
  httpStatusCodesValidRule,
} from './rules/contract.js';
import {
  dataMigrationPresentRule,
  dataRollbackPresentRule,
  dataDropFlaggedHighRiskRule,
  acceptanceHasTestRule,
  testCaseFieldsRequiredRule,
  authChangesFlaggedRule,
  highBlastRadiusHasRollbackRule,
  estimatePrsMatchesReposRule,
  estimateWithinSimilarRule,
} from './rules/data-tests-risks.js';

/**
 * The default rule pack. Adding a rule = one entry here + one file
 * under `rules/`. Order is non-significant; rules don't compose.
 */
export const defaultRulePack: PlanRule[] = [
  // Shape
  requiredFieldsPresentRule,
  schemaDiscriminatorRule,
  contentHashPresentRule,
  // Floor
  problemStatementLengthRule,
  problemWhyNowLengthRule,
  successSignalsNonEmptyRule,
  scopeInScopeNonEmptyRule,
  reposNonEmptyRule,
  eachInScopeHasAcceptanceRule,
  reposHaveChangesNarrativeRule,
  // KB
  repoExistsRule,
  fileModifiedExistsRule,
  fileNewParentExistsRule,
  symbolModifiedExistsRule,
  // Contract
  contractProducerKnownRule,
  contractConsumersKnownRule,
  httpPathFormatRule,
  httpStatusCodesValidRule,
  // Data / tests / risk / budget
  dataMigrationPresentRule,
  dataRollbackPresentRule,
  dataDropFlaggedHighRiskRule,
  acceptanceHasTestRule,
  testCaseFieldsRequiredRule,
  authChangesFlaggedRule,
  highBlastRadiusHasRollbackRule,
  estimatePrsMatchesReposRule,
  estimateWithinSimilarRule,
];

export interface PlanValidationReport {
  /** ISO. */
  generatedAt: string;
  planVersion: number;
  planSlug: string;
  /** sha256 of the plan canonical JSON — pins the report to a content hash. */
  planHash: string;
  issues: Issue[];
  counts: {
    errors: number;
    warnings: number;
    infos: number;
  };
}

export interface RunRulesOptions {
  /** Override the rule pack; defaults to `defaultRulePack`. */
  rules?: PlanRule[];
}

/**
 * Apply every rule in `pack` to `plan` against `ctx` and aggregate the
 * resulting `Issue[]`. Pure — same inputs always produce the same
 * output. Rule failures (rule throws) are NOT swallowed; the runner
 * lets them propagate so a buggy rule surfaces in tests rather than
 * silently dropping issues.
 */
export function runPlanRules(
  plan: Plan,
  ctx: RuleContext,
  opts: RunRulesOptions = {},
): PlanValidationReport {
  const pack = opts.rules ?? defaultRulePack;
  const issues: Issue[] = [];
  for (const rule of pack) {
    const fired = rule(plan, ctx);
    if (fired?.length) issues.push(...fired);
  }
  return {
    generatedAt: new Date().toISOString(),
    planVersion: plan.version,
    planSlug: plan.slug,
    planHash: plan.contentHash,
    issues,
    counts: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      infos: issues.filter((i) => i.severity === 'info').length,
    },
  };
}
