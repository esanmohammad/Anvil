/**
 * `per-repo-build` — Phase 4f.3 of the dashboard consolidation.
 *
 * Lifts the build-stage-specific per-repo + per-task fanout that
 * `pipeline-runner.ts:runBuildForRepo()` implements:
 *
 *   - Parse `TASKS.md` via `parseTasks()` and group via
 *     `groupTasksForExecution()` (P5 — task batches with stable system
 *     prompt for prompt-cache hits across spawns).
 *   - Run each group serially; within a group, fan tasks out in parallel.
 *   - Per-task spawns disable Read/Grep/Glob/Agent — every file the engineer
 *     needs is pre-bundled into the per-task user prompt.
 *   - Fallback path when TASKS.md isn't parseable: single repo-wide spawn
 *     with the same Read/Grep/Glob/Agent lockdown.
 *   - Combine task artifacts in original task order with the legacy
 *     `\n\n---\n\n` separator.
 *
 * As with Phase 4f.2, `pipeline-runner.runBuildForRepo` keeps owning the
 * dashboard state mutations and project-event emission today; this module
 * only owns the spawn-orchestration shape so 4f.7 can register the Step
 * once `Pipeline.run()` becomes the orchestrator.
 */
import type { ParsedTask } from '../engineer-task-bundler.js';
import type { AgentManager } from '@anvil/agent-core';
import type { Step, StepContext } from '@anvil/core-pipeline';
/**
 * Per-task disallowedTools rule. Differs from the general
 * `disallowedToolsForPersona('engineer')` (which only disables `Agent`):
 * during build, every file the engineer needs is pre-bundled into the
 * user prompt, so Read/Grep/Glob are also disabled to force the model to
 * use what's been provided. Mirrors `pipeline-runner.ts:1847,1890`.
 */
export declare const BUILD_DISALLOWED_TOOLS: readonly string[];
export interface RunBuildForRepoOptions {
    agentManager: AgentManager;
    /** Project slug — forwarded to the spawn config. */
    project: string;
    /** Stage name (typically `'build'`); part of the agent's `stage` label. */
    stageName: string;
    /** Persona running the stage (typically `'engineer'`). */
    persona: string;
    /** Resolved model id for the build stage. */
    model: string;
    /** Optional output-token ceiling. */
    maxOutputTokens?: number;
    /** Repo this invocation targets. */
    repoName: string;
    /** Absolute path to the repo's working copy. */
    repoPath: string;
    /** Pre-built per-repo project (system) prompt. */
    projectPrompt: string;
    /**
     * Contents of the repo's `TASKS.md` artifact. Caller loads from disk
     * (FeatureStore in PipelineRunner) and passes the string. Empty string
     * triggers the fallback path.
     */
    tasksMarkdown: string;
    /** Builds the per-task user prompt (file bundle + spec slice + instructions). */
    buildPerTaskPrompt: (task: ParsedTask) => string;
    /** Builds the fallback user prompt when TASKS.md isn't parseable. */
    buildFallbackPrompt: () => string;
    /** Returns true when the run has been cancelled — checked between groups. */
    isCancelled: () => boolean;
    /** Called once per spawn with the agent id (caller broadcasts state). */
    onAgentSpawned?: (agentId: string) => void;
    /** Called when the agent's stop_reason is `max_tokens`. */
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /** Optional informational events for the dashboard's output panel. */
    onProjectEvent?: (level: 'info' | 'warn', message: string) => void;
    /** Override poll cadence (forwarded to spawnAndWait). Test seam. */
    pollIntervalMs?: number;
    /** Override sleep primitive (forwarded to spawnAndWait). Test seam. */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Per-stage allow list for tool names. Build needs read+write+exec —
     * without this, agentic non-Claude adapters fall back to read-only and
     * the engineer can't actually edit code.
     */
    allowedTools?: string[];
}
export interface RunBuildForRepoResult {
    /** Combined artifact (task outputs joined in original task order). */
    artifact: string;
    /** Aggregate USD cost across all spawns. */
    cost: number;
    /** Number of parsed tasks. Zero when the fallback path ran. */
    taskCount: number;
    /** True when TASKS.md wasn't parseable and the single-repo path ran. */
    fallback: boolean;
    /** Aggregate input tokens across all per-task spawns. */
    inputTokens: number;
    /** Aggregate output tokens across all per-task spawns. */
    outputTokens: number;
    /** Aggregate prompt-cache READ tokens across all per-task spawns. */
    cacheReadTokens: number;
    /** Aggregate prompt-cache WRITE tokens across all per-task spawns. */
    cacheWriteTokens: number;
}
interface TaskOutput {
    id: string;
    title: string;
    artifact: string;
}
/**
 * Combine per-task artifacts in the original task order. Mirrors
 * `pipeline-runner.ts:1925-1928` verbatim.
 */
export declare function combineTaskArtifacts(tasks: ReadonlyArray<ParsedTask>, taskOutputs: ReadonlyArray<TaskOutput>): string;
/**
 * Run the build stage for one repo. Falls back to a single repo-wide
 * spawn when TASKS.md isn't parseable.
 *
 * Per-task failures are swallowed into the artifact as `UNRESOLVED:`
 * placeholders (same as legacy) so a single bad task doesn't kill the
 * whole repo's build. The fallback path is NOT failure-tolerant —
 * agent rejections propagate so the caller can mark the repo failed.
 */
export declare function runBuildForOneRepo(opts: RunBuildForRepoOptions): Promise<RunBuildForRepoResult>;
export interface PerRepoBuildStepOptions {
    /** Optional Step id override; defaults to `per-repo-build:<stageName>`. */
    id?: string;
    agentManager: AgentManager;
    project: string;
    stageName: string;
    persona: string;
    model: string;
    maxOutputTokens?: number;
    /** Builds the per-repo project (system) prompt. */
    buildProjectPrompt: (repoName: string) => string;
    /** Loads the contents of the repo's `TASKS.md`. Empty string → fallback. */
    loadTasksMarkdown: (repoName: string) => string;
    /** Builds the per-task user prompt for one task in one repo. */
    buildPerTaskPrompt: (repoName: string, repoPath: string, task: ParsedTask) => string;
    /** Builds the fallback user prompt for one repo (no parseable tasks). */
    buildFallbackPrompt: (repoName: string, repoPath: string) => string;
    /** Called once per spawn with the agent id. */
    onAgentSpawned?: (repoName: string, agentId: string) => void;
    /** Called when the agent's stop_reason is `max_tokens`. */
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /** Project-level events for the dashboard's output panel. */
    onProjectEvent?: (repoName: string, level: 'info' | 'warn', message: string) => void;
    /**
     * Persists the artifact for this repo (e.g. writes
     * `repos/<repo>/BUILD.md`). Invoked AFTER the build completes.
     */
    writeRepoArtifact?: (repoName: string, artifact: string) => void;
    /**
     * Optional cancellation predicate — defaults to checking
     * `ctx.signal.aborted`. Override when the caller has its own cancel flag
     * (e.g. PipelineRunner.cancelled).
     */
    isCancelled?: (ctx: StepContext<unknown>) => boolean;
    /** Test seams. */
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Step factory for the per-repo build. Declares `parallelism: 'per-repo'`
 * so the Pipeline walker (Phase 4a) fans `run()` across `ctx.repoPaths`
 * keys. Each invocation handles one repo and returns its combined
 * artifact + total cost; the walker aggregates into a
 * `Record<string, RunBuildForRepoResult>`.
 *
 * NOT auto-registered in `buildDashboardStepRegistry` — Phase 4f.7 wires
 * registration once `Pipeline.run()` becomes the orchestrator.
 */
export declare function createPerRepoBuildStep(opts: PerRepoBuildStepOptions): Step<unknown, RunBuildForRepoResult>;
export {};
//# sourceMappingURL=per-repo-build.step.d.ts.map