/**
 * Phase H10 — `per-repo-build.step` was promoted into core-pipeline.
 * This file is now a thin re-export shim. The legacy
 * `runBuildForOneRepo({agentManager, ...})` API was retired —
 * callers must construct an `AgentRunner`.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`.
 */
export { runBuildForOneRepo, combineTaskArtifacts, createPerRepoBuildStep, BUILD_DISALLOWED_TOOLS, } from '@esankhan3/anvil-core-pipeline';
//# sourceMappingURL=per-repo-build.step.js.map