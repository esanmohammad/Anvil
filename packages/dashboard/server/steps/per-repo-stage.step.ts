/**
 * Phase H9 — `per-repo-stage.step` was promoted into core-pipeline.
 * This file is now a thin re-export shim. The legacy
 * `runPerRepoStageForRepo({agentManager, ...})` API was retired —
 * callers must construct an `AgentRunner` (e.g. dashboard's
 * `AgentManagerRunner`) and pass it as `runner`.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`.
 */

export {
  disallowedToolsForPersona,
  runPerRepoStageForRepo,
  combinePerRepoArtifacts,
  createPerRepoStageStep,
} from '@esankhan3/anvil-core-pipeline';
export type {
  RunPerRepoStageOptions,
  RunPerRepoStageResult,
  PerRepoStageStepOptions,
} from '@esankhan3/anvil-core-pipeline';
