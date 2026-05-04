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
export { createFeatureManifestStep, FEATURE_MANIFEST_STAGES, } from './feature-manifest.step.js';
export type { FeatureManifestStepOptions } from './feature-manifest.step.js';
export { createPlanRiskStep, PLAN_RISK_ARTIFACT_ID, } from './plan-risk.step.js';
export type { PlanRiskStepOptions } from './plan-risk.step.js';
export { createTaskBundlerStep, TASK_BUNDLES_ARTIFACT_ID, } from './task-bundler.step.js';
export type { TaskBundlerStepOptions, TaskBundleOutput, } from './task-bundler.step.js';
export { createClarifyStep, parseClarifyQuestions, formatQAPairs, buildClarifySynthesisPrompt, CLARIFY_QA_ARTIFACT_ID, } from './clarify.step.js';
export type { ClarifyStepOptions, ClarifyResult, ClarifyQAPair, ClarifyEvent, } from './clarify.step.js';
export { runClarifyForProject, createClarifyStageStep, } from './clarify-stage.step.js';
export type { RunClarifyForProjectOptions, RunClarifyForProjectResult, ClarifyStageStepOptions, } from './clarify-stage.step.js';
export { runFixLoop, createFixLoopStep, hasValidationFailures, extractRepoSection, } from './fix-loop.step.js';
export type { RunFixLoopOptions, RunFixLoopResult, FixLoopStepOptions, } from './fix-loop.step.js';
export { runTestGenForProject, createTestGenStageStep, pickRepoForBehavior, } from './test-gen-stage.step.js';
export type { RunTestGenForProjectOptions, TestGenStageStepOptions, TestGenArtifactEvent, } from './test-gen-stage.step.js';
export { pullBaseBranchForRepos, runPostBuildGuards, deployProject, createFeatureBranches, runSilent, fileExists, } from './workspace-ops.js';
export type { PullBaseBranchOptions, RunPostBuildGuardsOptions, DeployProjectOptions, DeployArtifact, CreateFeatureBranchesOptions, ShellRunner, RepoCommands, } from './workspace-ops.js';
export { buildProjectPrompt, buildRepoProjectPrompt, buildClarifyExplorePrompt, buildStagePrompt, buildRepoStagePrompt, buildPerTaskPrompt, buildManifestPrefix, warnIfSystemPromptOversized, loadPersonaPromptSync, injectTemplateVars, } from './prompt-builders.js';
export type { PromptBuilderContext, StageInfo, KbTier, RepoArtifacts, } from './prompt-builders.js';
export { attachCostBudgetHook } from './cost-budget.hook.js';
export type { CostBudgetHookOptions, CostBudgetHookHandle, } from './cost-budget.hook.js';
export { spawnAndWait, waitForAgent } from './agent-spawner.js';
export type { SpawnAndWaitOptions, SpawnAndWaitResult, WaitForAgentOptions, } from './agent-spawner.js';
export { runPerRepoStageForRepo, combinePerRepoArtifacts, createPerRepoStageStep, disallowedToolsForPersona, } from './per-repo-stage.step.js';
export type { RunPerRepoStageOptions, RunPerRepoStageResult, PerRepoStageStepOptions, } from './per-repo-stage.step.js';
export { runBuildForOneRepo, combineTaskArtifacts, createPerRepoBuildStep, BUILD_DISALLOWED_TOOLS, } from './per-repo-build.step.js';
export type { RunBuildForRepoOptions, RunBuildForRepoResult, PerRepoBuildStepOptions, } from './per-repo-build.step.js';
//# sourceMappingURL=index.d.ts.map