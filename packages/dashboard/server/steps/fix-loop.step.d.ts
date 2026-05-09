/**
 * `fix-loop` — Phase 4f.5 of the dashboard consolidation.
 *
 * Lifts the validation-failure → engineer-fix loop that
 * `pipeline-runner.ts:runFixLoop()` implements, plus the two pure
 * helpers it depends on (`hasValidationFailures`, `extractRepoSection`).
 *
 * Behavior parity with the legacy:
 *   - Single-repo path when `repoNames.length === 0` (uses workspaceDir
 *     as cwd) — spawns one fixer agent.
 *   - Per-repo path otherwise — extracts each repo's section out of the
 *     combined VALIDATE.md artifact, skips repos whose section has no
 *     failure markers, fans the remaining repos out via Promise.all.
 *   - Cross-attempt session resume (P9): on `attempt > 1`, if a prior
 *     agent id exists for the repo (or single path), call
 *     `agentManager.sendInput(priorId, followUp)` instead of spawning a
 *     fresh agent. The map is mutated in place so the next attempt
 *     finds the latest id.
 *   - Disallowed tools = `['Agent']` (engineer + tester rule).
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { Step, StepContext } from '@esankhan3/anvil-core-pipeline';
/**
 * Pure helper: detect validation failures in an artifact. Lifted
 * verbatim from `pipeline-runner.ts:hasValidationFailures()` so the
 * regex set is unchanged.
 */
export declare function hasValidationFailures(artifact: string): boolean;
/**
 * Pure helper: extract the section of a combined VALIDATE.md artifact
 * that belongs to a specific repo. Lifted verbatim from
 * `pipeline-runner.ts:extractRepoSection()`.
 */
export declare function extractRepoSection(artifact: string, repoName: string): string;
export interface RunFixLoopOptions {
    /**
     * Multi-turn agent surface. When supplied, fix-loop attempts spawn
     * via `agentSession.start` and resume via `agentSession.sendInput`,
     * routing through chain-fallback + empty-output throws.
     */
    agentSession?: import('@esankhan3/anvil-core-pipeline').AgentSession;
    /** Legacy direct path — used when `agentSession` is omitted. */
    agentManager?: AgentManager;
    /** Project slug — forwarded to the spawn config. */
    project: string;
    /** Resolved model id for the validate stage (the legacy resolves it then). */
    model?: string;
    /** Optional output-token ceiling — legacy passes `maxOutputTokensForStage('build')`. */
    maxOutputTokens?: number;
    /** Workspace root — used as cwd for the single-repo path. */
    workspaceDir: string;
    /** Repo names; empty array triggers the single-repo path. */
    repoNames: string[];
    /** Map of repoName → absolute path. */
    repoPaths: Record<string, string>;
    /** Combined VALIDATE.md artifact from the prior validate stage. */
    validateArtifact: string;
    /** Attempt count (1 for first fix, ≥2 to resume the prior session). */
    attempt: number;
    /**
     * Per-repo prior-agent map. Mutated in place — callers retain the same
     * Map across attempts so resume-via-sendInput finds the right session.
     */
    priorByRepo: Map<string, string>;
    /**
     * Single-mode prior agent id. Returned alongside the result so the
     * caller can store it back for the next attempt.
     */
    priorSingleId: string | null;
    /** Builds the project (system) prompt for the build stage (single-repo path). */
    buildProjectPromptForBuildStage: () => string;
    /** Builds the per-repo project prompt for the build stage. */
    buildRepoProjectPromptForBuildStage: (repoName: string) => string;
    /** Returns true when the run has been cancelled. */
    isCancelled: () => boolean;
    /** Called when the agent's stop_reason is `max_tokens`. */
    onTruncation?: (agentName: string, outputTokens: number) => void;
    /** Test seams. */
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Per-stage allow list. Fix-loop needs read+write+exec to apply
     *  mechanical fixes — without this, agentic non-Claude adapters fall
     *  back to read-only and the engineer agent can't actually edit code. */
    allowedTools?: string[];
}
export interface RunFixLoopResult {
    /** Combined fix-output across all repos (single-repo: that one agent's output). */
    artifact: string;
    /** Aggregate USD cost. */
    cost: number;
    /**
     * Updated single-mode agent id. Caller stores this so attempt+1 can
     * resume via sendInput. Unchanged on per-repo path.
     */
    newSingleId: string | null;
    /** Aggregate input tokens across all spawns / resumes in this attempt. */
    inputTokens: number;
    /** Aggregate output tokens across all spawns / resumes in this attempt. */
    outputTokens: number;
    /** Aggregate cache READ tokens. */
    cacheReadTokens: number;
    /** Aggregate cache WRITE tokens. */
    cacheWriteTokens: number;
}
/**
 * Run one fix-loop attempt. Mutates `priorByRepo` in place; returns the
 * single-mode agent id alongside the artifact + cost so the caller can
 * persist it for the next attempt.
 *
 * Per-repo failures are NOT swallowed here (unlike the per-task build
 * fanout) — a single repo's fix throwing rejects the whole attempt,
 * matching legacy behavior.
 */
export declare function runFixLoop(opts: RunFixLoopOptions): Promise<RunFixLoopResult>;
export interface FixLoopStepOptions extends Omit<RunFixLoopOptions, 'isCancelled' | 'validateArtifact' | 'attempt'> {
    /** Optional Step id override; defaults to `fix-loop`. */
    id?: string;
    /**
     * Reads the validate artifact + attempt count from the Step input.
     * Default expects `ctx.input` shaped as `{ validateArtifact, attempt }`.
     */
    readInput?: (ctx: StepContext<unknown>) => {
        validateArtifact: string;
        attempt: number;
    };
    /**
     * Optional cancellation predicate — defaults to `ctx.signal.aborted`.
     */
    isCancelled?: (ctx: StepContext<unknown>) => boolean;
}
/**
 * Step factory for one fix-loop attempt. Phase 4f.7 wires registration
 * once `Pipeline.run()` becomes the orchestrator.
 *
 * Note: the legacy `runFixLoop` is invoked imperatively from within the
 * validate-loop iteration in pipeline-runner. The Step factory shape is
 * exposed for parity testing + future composition; today the production
 * caller goes through `runFixLoop()` directly.
 */
export declare function createFixLoopStep(opts: FixLoopStepOptions): Step<unknown, RunFixLoopResult>;
//# sourceMappingURL=fix-loop.step.d.ts.map