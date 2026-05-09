/**
 * `prompt-builders` — Phase 4f.7 of the dashboard consolidation.
 *
 * Lifts the 6 system / user prompt builders + 2 helpers that
 * `pipeline-runner.ts` carried for the agent stages:
 *
 *   - `buildProjectPrompt(ctx, stage)`               — system prompt for non-repo stages
 *   - `buildRepoProjectPrompt(ctx, stage, repoName)` — system prompt scoped to one repo
 *   - `buildClarifyExplorePrompt(ctx)`               — Phase A clarify user prompt
 *   - `buildStagePrompt(ctx, stage, prevArtifact)`   — non-repo user prompt
 *   - `buildRepoStagePrompt(ctx, stage, repoName, prevArtifact)` — per-repo user prompt
 *   - `buildPerTaskPrompt(ctx, repoName, repoPath, task, specsMd)` — single-task user prompt
 *   - `buildManifestPrefix(ctx)`                     — feature-manifest prefix block
 *   - `warnIfSystemPromptOversized(ctx, label, prompt)` — > 60KB warn-and-emit
 *
 * Plus the two file-loader helpers that the prompt path needs:
 *   - `loadPersonaPromptSync(personaName)`
 *   - `injectTemplateVars(prompt, vars)`
 *
 * Each builder takes a `PromptBuilderContext` that bundles every
 * dependency the legacy code reached through `this.*`. The context is
 * intentionally a snapshot of getters + closures so:
 *   - Tests can supply a fully-stubbed context without spinning up
 *     `MemoryStore` / `KnowledgeBaseManager` / `FeatureStore`.
 *   - The cache-stability invariant (P1 — byte-identical bytes across
 *     stages of one run) is preserved by the caller's memoised getters.
 */
import { type ParsedTask } from '@esankhan3/anvil-core-pipeline';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { ProjectInfo } from '../project-loader.js';
export type KbTier = 'full' | 'repo-focused' | 'index-only';
/**
 * Minimal stage shape consumed by the prompt-builders. The legacy
 * `StageDefinition` from pipeline-runner is structurally compatible
 * (it has `name`, `persona`, `label` plus more fields the builders
 * don't use).
 */
export interface StageInfo {
    name: string;
    persona: string;
    label: string;
}
/** Per-repo artifact bundle the legacy `loadRepoArtifacts` returns. */
export interface RepoArtifacts {
    requirements: string;
    specs: string;
    tasks: string;
    build: string;
}
/**
 * Bundle of dependencies the prompt-builders need. Owners (PipelineRunner
 * today) construct this once per builder invocation by closing over their
 * instance state. Tests can stub out individual getters.
 */
export interface PromptBuilderContext {
    project: string;
    feature: string;
    model: string;
    workspaceDir: string;
    baseBranch: string;
    failureContext?: string;
    /**
     * Reviewer feedback from the most recent pause resume. Surfaced at the
     * top of the next stage's user prompt as a "User note from review:"
     * block. PipelineRunner consumes-and-clears its review-note slot when
     * building this context so the note only reaches the immediate next
     * stage.
     */
    reviewNote?: string;
    actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
    repoNames: string[];
    featureSlug: string;
    projectYaml: string;
    projectInfo: ProjectInfo | null;
    repoPaths: Record<string, string>;
    getStableMemoryBlock: () => string;
    getStableConventionsBlock: () => string;
    getStableProjectYamlSlice: (maxLen: number) => string;
    getStableKbBlock: (tier: KbTier, repoName?: string) => {
        content: string;
        sourceLabel: string;
    };
    getStableManifestBlock: () => string;
    getLockedKbTier: (stage: StageInfo) => KbTier | 'none';
    loadRepoArtifacts: (repoName: string) => RepoArtifacts;
    loadHighLevelRequirements: () => string;
    kbManager: KnowledgeBaseManager | null;
    emit: (event: string, payload: unknown) => void;
}
/**
 * Load a persona's prompt markdown file. Resolution order:
 *   1. User override at `$ANVIL_HOME/personas/<persona>.md`
 *   2. CLI bundle / monorepo source-tree paths
 *
 * Lifted verbatim from `pipeline-runner.ts`. Callers MUST handle the
 * empty-string return (persona file missing → callers fall back to
 * a minimal hardcoded prompt).
 */
export declare function loadPersonaPromptSync(personaName: string): string;
/**
 * Inject `{{key}}` template variables into a persona prompt.
 * Lifted verbatim from `pipeline-runner.ts`.
 */
export declare function injectTemplateVars(prompt: string, vars: Record<string, string>): string;
export declare function warnIfSystemPromptOversized(ctx: PromptBuilderContext, label: string, projectPrompt: string): void;
export declare function buildManifestPrefix(ctx: PromptBuilderContext): string;
export declare function buildProjectPrompt(ctx: PromptBuilderContext, stage: StageInfo): string;
export declare function buildRepoProjectPrompt(ctx: PromptBuilderContext, stage: StageInfo, repoName: string): string;
export declare function buildClarifyExplorePrompt(ctx: PromptBuilderContext): string;
export declare function buildStagePrompt(ctx: PromptBuilderContext, stage: StageInfo, prevArtifact: string): string;
export declare function buildRepoStagePrompt(ctx: PromptBuilderContext, stage: StageInfo, repoName: string, prevArtifact: string): string;
export declare function buildPerTaskPrompt(ctx: PromptBuilderContext, repoName: string, repoPath: string, task: ParsedTask, specsMd: string): string;
//# sourceMappingURL=prompt-builders.d.ts.map