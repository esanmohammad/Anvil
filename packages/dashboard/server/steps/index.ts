/**
 * Dashboard Step registry barrel — Phase 4 of the dashboard consolidation.
 *
 * Phases 4b–4f progressively lift `pipeline-runner.ts` features into
 * `Step<I, O>` implementations under this directory:
 *   - 4b — feature-store.step.ts (FEATURE-MANIFEST.json producer)
 *   - 4c — plan-risk.step.ts     (PLAN-RISK.json producer)
 *   - 4d — task-bundler.step.ts  (TASK-BUNDLES.json producer)
 *   - 4e — clarify.step.ts       (interactive WS clarify)
 *   - 4f — final integration:    pipeline-runner.ts shrinks to a thin façade
 *                                that registers Steps + calls `Pipeline.run()`
 *
 * Phase 4a lands the empty scaffold so 4b–4f can land incrementally without
 * breaking the existing `PipelineRunner` orchestrator (which is untouched
 * until 4f).
 */

export { buildDashboardStepRegistry } from './build-registry.js';
export type { DashboardStepRegistryDeps } from './build-registry.js';
export {
  createFeatureManifestStep,
  FEATURE_MANIFEST_STAGES,
} from './feature-manifest.step.js';
export type { FeatureManifestStepOptions } from './feature-manifest.step.js';
export {
  createPlanRiskStep,
  PLAN_RISK_ARTIFACT_ID,
} from './plan-risk.step.js';
export type { PlanRiskStepOptions } from './plan-risk.step.js';
