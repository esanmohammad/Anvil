/**
 * `per-repo-stage` — Phase 4f.2 of the dashboard consolidation.
 *
 * Lifts the per-repo work that `pipeline-runner.ts:runPerRepoStage()` does
 * for ONE repo into a reusable helper + Step factory:
 *
 *   - `runPerRepoStageForRepo(opts)` — spawn-and-wait for a single repo,
 *     applying the persona-aware `disallowedTools` rule that's stable
 *     across the legacy per-repo stages (requirements, specs, tasks, validate).
 *   - `combinePerRepoArtifacts(results)` — joins per-repo artifacts using
 *     the legacy `## ${repoName}\n\n${artifact}` separator format.
 *   - `createPerRepoStageStep(opts)` — `Step<string, RunPerRepoStageResult>`
 *     factory with `parallelism: 'per-repo'`. Phase 4f.7 will register
 *     this Step so the Pipeline walker drives the per-repo fanout
 *     instead of the manual loop in pipeline-runner.runPerRepoStage.
 *
 * Today (Phase 4f.2) `pipeline-runner.runPerRepoStage` keeps owning the
 * loop — it calls `runPerRepoStageForRepo` once per repo so the dashboard
 * state mutations (state.stages[i].repos[r].status / agentId / cost /
 * artifact / error) and the Promise.all aggregation stay in pipeline-runner.
 *
 * The build stage's per-task fanout is NOT lifted here — see Phase 4f.3
 * (`per-repo-build.step.ts`).
 */
import type { AgentManager } from '@anvil/agent-core';
import type { Step, StepContext } from '@anvil/core-pipeline';
export declare function disallowedToolsForPersona(persona: string): string[];
export interface RunPerRepoStageOptions {
    /** AgentManager instance owned by the caller (PipelineRunner today). */
    agentManager: AgentManager;
    /** Project slug — forwarded to the spawn config. */
    project: string;
    /** Stage name (e.g. 'specs'); becomes part of the agent's `stage` label. */
    stageName: string;
    /** Persona running the stage (drives the disallowedTools rule). */
    persona: string;
    /** Resolved model id for this stage. */
    model: string;
    /** Optional output-token ceiling for this stage. */
    maxOutputTokens?: number;
    /** Repo this invocation targets. */
    repoName: string;
    /** Absolute path to the repo's working copy. */
    repoPath: string;
    /** Pre-built per-repo project (system) prompt. */
    projectPrompt: string;
    /** Pre-built per-repo stage (user) prompt. */
    prompt: string;
    /** Returns true when the run has been cancelled — checked at every poll. */
    isCancelled: () => boolean;
    /** Called once with the freshly-spawned agent id (caller broadcasts state). */
    onSpawn?: (agentId: string) => void;
    /** Called when the agent's stop_reason is `max_tokens`. */
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /** Override poll cadence (forwarded to spawnAndWait). Test seam. */
    pollIntervalMs?: number;
    /** Override sleep primitive (forwarded to spawnAndWait). Test seam. */
    sleep?: (ms: number) => Promise<void>;
}
export interface RunPerRepoStageResult {
    agentId: string;
    artifact: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
/**
 * Spawn one agent for one repo and resolve when it completes. Throws on
 * cancellation or agent-side error/kill — the caller's loop is expected
 * to catch and apply per-repo state cleanup (status='failed' + error).
 */
export declare function runPerRepoStageForRepo(opts: RunPerRepoStageOptions): Promise<RunPerRepoStageResult>;
/**
 * Combine per-repo artifacts using the legacy `## ${repoName}\n\n${artifact}`
 * separator. Empty-artifact entries are dropped so the output stays clean
 * for downstream stages that read the combined string.
 *
 * Mirrors `pipeline-runner.ts:1807-1809` verbatim.
 */
export declare function combinePerRepoArtifacts(results: ReadonlyArray<{
    repoName: string;
    artifact: string;
}>): string;
export interface PerRepoStageStepOptions {
    /** Optional override for the Step id; defaults to `per-repo-stage:<stageName>`. */
    id?: string;
    /** AgentManager instance owned by the caller. */
    agentManager: AgentManager;
    /** Project slug — forwarded to the spawn config. */
    project: string;
    /** Stage name (e.g. 'specs'); becomes part of the agent's `stage` label. */
    stageName: string;
    /** Persona running the stage. */
    persona: string;
    /** Resolved model id for this stage. */
    model: string;
    /** Optional output-token ceiling for this stage. */
    maxOutputTokens?: number;
    /** Builds the per-repo project (system) prompt. */
    buildProjectPrompt: (repoName: string) => string;
    /** Builds the per-repo stage (user) prompt from the previous stage's artifact. */
    buildStagePrompt: (repoName: string, prevArtifact: string) => string;
    /** Called when the agent for a repo is spawned (caller broadcasts state). */
    onAgentSpawned?: (repoName: string, agentId: string) => void;
    /** Called when the agent's stop_reason is `max_tokens`. */
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /**
     * Persists the artifact for this repo (e.g. writes `repos/<repo>/SPECS.md`).
     * Invoked AFTER the agent completes successfully.
     */
    writeRepoArtifact?: (repoName: string, artifact: string) => void;
    /**
     * Optional cancellation predicate — defaults to checking
     * `ctx.signal.aborted`. Override when the caller has its own cancel flag
     * (e.g. PipelineRunner.cancelled).
     */
    isCancelled?: (ctx: StepContext<string>) => boolean;
    /** Override poll cadence (forwarded to the per-repo helper). Test seam. */
    pollIntervalMs?: number;
    /** Override sleep primitive (forwarded to the per-repo helper). Test seam. */
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Step factory for the per-repo stage. Declares `parallelism: 'per-repo'`
 * so the Pipeline walker fans `run()` across `ctx.repoPaths` keys
 * (Phase 4a). Each invocation handles one repo and returns its artifact
 * + cost; the walker aggregates into a `Record<string, RunPerRepoStageResult>`.
 *
 * NOT auto-registered in `buildDashboardStepRegistry` — Phase 4f.7 will
 * wire registration once `Pipeline.run()` becomes the orchestrator.
 */
export declare function createPerRepoStageStep(opts: PerRepoStageStepOptions): Step<string, RunPerRepoStageResult>;
//# sourceMappingURL=per-repo-stage.step.d.ts.map