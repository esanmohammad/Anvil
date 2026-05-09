/**
 * Phase H13 — `prompt-builders` was promoted into core-pipeline.
 * Concrete dashboard types (`KnowledgeBaseManager`, `ProjectInfo`)
 * become structural (`KbManagerLike`, `PromptBuilderProjectInfo`) in
 * the canonical version. This file is a thin re-export shim.
 *
 * @deprecated Import from `@esankhan3/anvil-core-pipeline`:
 *   import {
 *     loadPersonaPromptSync, injectTemplateVars,
 *     warnIfSystemPromptOversized, buildManifestPrefix,
 *     buildProjectPrompt, buildRepoProjectPrompt,
 *     buildClarifyExplorePrompt, buildStagePrompt,
 *     buildRepoStagePrompt, buildPerTaskPrompt,
 *     type PromptBuilderContext, type PromptBuilderProjectInfo,
 *     type StageInfo, type RepoArtifacts, type KbTier,
 *   } from '@esankhan3/anvil-core-pipeline';
 */
export { loadPersonaPromptSync, injectTemplateVars, warnIfSystemPromptOversized, buildManifestPrefix, buildProjectPrompt, buildRepoProjectPrompt, buildClarifyExplorePrompt, buildStagePrompt, buildRepoStagePrompt, buildPerTaskPrompt, } from '@esankhan3/anvil-core-pipeline';
//# sourceMappingURL=prompt-builders.js.map