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

import { spawnAndWait } from './agent-spawner.js';
import type { AgentManager } from '@anvil/agent-core';
import type { Step, StepContext } from '@anvil/core-pipeline';

/**
 * Per-persona tool gates. The `Agent` tool is always disabled (P8 —
 * sub-agents inherit context and double the token cost).
 *
 * Token-optimization rule (Phase 1 of TOKEN-OPTIMIZATION-PLAN, follow-up):
 *   The Knowledge Base is injected into every system prompt for the
 *   spec-writing personas (analyst, architect, lead). Without explicit
 *   tool restrictions the model still re-explores the codebase via
 *   Grep/Glob, defeating the optimization. Disable exploration tools for
 *   those personas — they keep `Read` so they can spot-check a specific
 *   file when the KB doesn't fully cover an implementation detail.
 *
 *   Clarifier KEEPS Grep/Glob: its job IS to explore the code to produce
 *   thoughtful questions for the user.
 */
const FILE_MUTATING_PERSONAS = new Set(['engineer', 'tester']);
const KB_ONLY_PERSONAS = new Set(['analyst', 'architect', 'lead']);

export function disallowedToolsForPersona(persona: string): string[] {
  if (FILE_MUTATING_PERSONAS.has(persona)) {
    return ['Agent'];
  }
  if (KB_ONLY_PERSONAS.has(persona)) {
    return ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'Agent'];
  }
  return ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent'];
}

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
  /**
   * Per-stage allow list for tool names (drives BuiltinToolExecutor for
   * non-Claude agentic adapters). When undefined the bridge falls back to
   * read-only — that's safe for analyst/architect stages but BREAKS
   * engineer/tester stages that need write/exec.
   */
  allowedTools?: string[];
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
export async function runPerRepoStageForRepo(
  opts: RunPerRepoStageOptions,
): Promise<RunPerRepoStageResult> {
  return spawnAndWait({
    agentManager: opts.agentManager,
    spec: {
      name: `${opts.persona}-${opts.repoName}`,
      persona: opts.persona,
      project: opts.project,
      stage: `${opts.stageName}:${opts.repoName}`,
      prompt: opts.prompt,
      model: opts.model,
      cwd: opts.repoPath,
      projectPrompt: opts.projectPrompt,
      permissionMode: 'bypassPermissions',
      disallowedTools: disallowedToolsForPersona(opts.persona),
      allowedTools: opts.allowedTools,
      maxOutputTokens: opts.maxOutputTokens,
    },
    isCancelled: opts.isCancelled,
    onSpawn: opts.onSpawn,
    onTruncation: opts.onTruncation,
    pollIntervalMs: opts.pollIntervalMs,
    sleep: opts.sleep,
  });
}

/**
 * Combine per-repo artifacts using the legacy `## ${repoName}\n\n${artifact}`
 * separator. Empty-artifact entries are dropped so the output stays clean
 * for downstream stages that read the combined string.
 *
 * Mirrors `pipeline-runner.ts:1807-1809` verbatim.
 */
export function combinePerRepoArtifacts(
  results: ReadonlyArray<{ repoName: string; artifact: string }>,
): string {
  return results
    .filter((r) => r.artifact)
    .map((r) => `## ${r.repoName}\n\n${r.artifact}`)
    .join('\n\n---\n\n');
}

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
export function createPerRepoStageStep(
  opts: PerRepoStageStepOptions,
): Step<string, RunPerRepoStageResult> {
  const id = opts.id ?? `per-repo-stage:${opts.stageName}`;

  return {
    id,
    name: `Per-repo stage (${opts.stageName})`,
    parallelism: 'per-repo',

    async run(ctx: StepContext<string>): Promise<RunPerRepoStageResult> {
      const repoName = ctx.repoName;
      if (!repoName) {
        throw new Error(
          `[${id}] requires ctx.repoName — did the walker forget to fan out?`,
        );
      }
      const repoPath = ctx.repoPaths?.[repoName];
      if (!repoPath) {
        throw new Error(
          `[${id}] no repoPath registered for "${repoName}"`,
        );
      }

      const isCancelled = opts.isCancelled
        ? () => opts.isCancelled!(ctx)
        : () => ctx.signal.aborted;

      const result = await runPerRepoStageForRepo({
        agentManager: opts.agentManager,
        project: opts.project,
        stageName: opts.stageName,
        persona: opts.persona,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        repoName,
        repoPath,
        projectPrompt: opts.buildProjectPrompt(repoName),
        prompt: opts.buildStagePrompt(repoName, ctx.input),
        isCancelled,
        onSpawn: opts.onAgentSpawned
          ? (agentId) => opts.onAgentSpawned!(repoName, agentId)
          : undefined,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
      });

      opts.writeRepoArtifact?.(repoName, result.artifact);

      return result;
    },
  };
}
