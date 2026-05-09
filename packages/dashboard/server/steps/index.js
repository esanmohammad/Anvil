/**
 * Dashboard Step registry barrel.
 *
 * After Phase H, the canonical step factories live in core-pipeline.
 * This barrel re-exports them through dashboard-local paths so
 * existing consumers keep working. Three local files remain because
 * they are adapters (NOT pure re-exports) — they accept the legacy
 * `agentManager`-based opts shape and bridge to the canonical
 * `AgentRunner` / `AgentSession` surface:
 *
 *   - validate.step.ts (back-compat for fix-flow.ts)
 *   - fix.step.ts      (back-compat for fix-flow.ts)
 *   - fix-loop.step.ts (back-compat for fix-flow.ts + pipeline-runner.ts)
 *   - clarify-stage.step.ts (back-compat for pipeline-runner.ts)
 *   - test-gen-stage.step.ts (loads dashboard-only deps via dynamic import)
 *
 * Pure shims have been removed; their re-exports here come straight
 * from `@esankhan3/anvil-core-pipeline`.
 */
export { buildDashboardStepRegistry } from './build-registry.js';
// Pure step factories — straight from canonical.
export { createFeatureManifestStep, FEATURE_MANIFEST_STAGES, createPlanRiskStep, PLAN_RISK_ARTIFACT_ID, createTaskBundlerStep, TASK_BUNDLES_ARTIFACT_ID, createClarifyStep, parseClarifyQuestions, formatQAPairs, buildClarifySynthesisPrompt, CLARIFY_QA_ARTIFACT_ID, runPerRepoStageForRepo, combinePerRepoArtifacts, createPerRepoStageStep, disallowedToolsForPersona, runBuildForOneRepo, combineTaskArtifacts, createPerRepoBuildStep, BUILD_DISALLOWED_TOOLS, buildProjectPrompt, buildRepoProjectPrompt, buildClarifyExplorePrompt, buildStagePrompt, buildRepoStagePrompt, buildPerTaskPrompt, buildManifestPrefix, warnIfSystemPromptOversized, loadPersonaPromptSync, injectTemplateVars, } from '@esankhan3/anvil-core-pipeline';
// Adapters that retain the legacy {agentManager,...} opts shape.
export { runClarifyForProject, createClarifyStageStep, } from './clarify-stage.step.js';
export { runFixLoop, createFixLoopStep, hasValidationFailures, extractRepoSection, } from './fix-loop.step.js';
export { runTestGenForProject, createTestGenStageStep, pickRepoForBehavior, } from './test-gen-stage.step.js';
// Dashboard-only modules that stay (workspace-ops, agent-spawner, hooks).
export { pullBaseBranchForRepos, runPostBuildGuards, deployProject, createFeatureBranches, runSilent, fileExists, } from './workspace-ops.js';
export { attachCostBudgetHook } from './cost-budget.hook.js';
export { spawnAndWait, waitForAgent } from './agent-spawner.js';
//# sourceMappingURL=index.js.map