/**
 * `@esankhan3/anvil-core-pipeline/plan` — Plan v2 schema, migration,
 * verification engine, compliance gates, and reconciliation helpers.
 *
 * The Plan vocabulary (`Plan`, `PlanRepoImpact`, `PlanContract`, …) is
 * re-exported through `utils/plan-types.js` for back-compat with code
 * that already imports from `@esankhan3/anvil-core-pipeline`. New code
 * SHOULD import from this barrel.
 */

export { migratePlanJsonToV2, emptyPlanV2 } from './migrate.js';
export { planContentHash, planContentHashShort } from './hash.js';

export type { Issue, IssueSeverity, RuleContext, PlanRule, AutoFixSuggestion } from './types.js';
export { runPlanRules, defaultRulePack } from './run-rules.js';
export type { PlanValidationReport } from './run-rules.js';

export type { PlanBinding } from './plan-binding.js';
export { bindPlan } from './plan-binding.js';

// Phase E — build-stage compliance
export {
  checkBuildCompliance,
  renderBuildComplianceMarkdown,
  buildComplianceFixPrompt,
} from './compliance/build.js';
export type {
  BuildComplianceReport,
  BuildComplianceProbes,
  ComplianceGap,
  GapKind,
} from './compliance/build.js';

// Phase F — validate-stage compliance
export {
  checkValidateCompliance,
  renderValidateComplianceMarkdown,
} from './compliance/validate.js';
export type {
  ValidateComplianceReport,
  ValidateComplianceProbes,
  ValidateComplianceGap,
  ValidateGapKind,
  TestRunStatus,
} from './compliance/validate.js';

// Phase G — post-ship reconciliation
export { reconcilePlan } from './compliance/reconcile.js';
export type { PlanReconciliation, ReconcileInput } from './compliance/reconcile.js';

// Phase I — cost policy + auto-refine
export {
  DEFAULT_COST_POLICY,
  resolveCostPolicy,
  CostBreachError,
} from './cost-policy.js';
export type { CostPolicy } from './cost-policy.js';
export { autoRefinePlan } from './auto-refine.js';
export type { AutoRefineOutcome } from './auto-refine.js';

// — Plan lifecycle walker (pure state machine)
export {
  initLifecycle,
  transitionLifecycle,
  snapshotLifecycle,
} from './lifecycle.js';
export type {
  LifecycleState,
  LifecycleContext,
  LifecycleEvent,
  LifecycleAction,
  LifecycleTransition,
  LifecycleSnapshot,
  TransitionResult,
} from './lifecycle.js';
