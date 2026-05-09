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

import { spawnAndWait } from './agent-spawner.js';
import {
  parseTasks,
  runTasksWithDependencyGraph,
  type ParsedTask,
} from '@esankhan3/anvil-core-pipeline';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { Step, StepContext } from '@esankhan3/anvil-core-pipeline';

/**
 * Per-task disallowedTools rule. Differs from the general
 * `disallowedToolsForPersona('engineer')` (which only disables `Agent`):
 * during build, every file the engineer needs is pre-bundled into the
 * user prompt, so Read/Grep/Glob are also disabled to force the model to
 * use what's been provided. Mirrors `pipeline-runner.ts:1847,1890`.
 */
export const BUILD_DISALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Agent'];

export interface RunBuildForRepoOptions {
  /**
   * Agent invocation surface. Per-task spawns flow through `agentRunner.run`
   * — chain-fallback, empty-throw defense, and on-spawn telemetry are baked
   * into the runner so this function stays substrate-agnostic.
   */
  agentRunner?: import('@esankhan3/anvil-core-pipeline').AgentRunner;
  /**
   * Legacy AgentManager path. Kept for back-compat — when `agentRunner`
   * is omitted, the function still spawns directly via spawnAndWait.
   * Slated for removal once all callers migrate.
   */
  agentManager?: AgentManager;
  /** Project slug — forwarded to the spawn config. */
  project: string;
  /** Stage name (typically `'build'`); part of the agent's `stage` label. */
  stageName: string;
  /** Persona running the stage (typically `'engineer'`). */
  persona: string;
  /** Resolved model id for the build stage. */
  model?: string;
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
export function combineTaskArtifacts(
  tasks: ReadonlyArray<ParsedTask>,
  taskOutputs: ReadonlyArray<TaskOutput>,
): string {
  const idOrder = new Map(tasks.map((t, i) => [t.id, i] as const));
  const sorted = [...taskOutputs].sort(
    (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0),
  );
  return sorted.map((t) => t.artifact.trim()).join('\n\n---\n\n');
}

/**
 * Format a per-task failure as a placeholder artifact so the combined
 * output documents what didn't land. Mirrors `pipeline-runner.ts:1909-1913`.
 */
function unresolvedArtifact(task: ParsedTask, message: string): string {
  return `## Implementation: ${task.id} — ${task.title}\n\nUNRESOLVED: ${message}\n`;
}

/**
 * Run the build stage for one repo. Falls back to a single repo-wide
 * spawn when TASKS.md isn't parseable.
 *
 * Per-task failures are swallowed into the artifact as `UNRESOLVED:`
 * placeholders (same as legacy) so a single bad task doesn't kill the
 * whole repo's build. The fallback path is NOT failure-tolerant —
 * agent rejections propagate so the caller can mark the repo failed.
 */
export async function runBuildForOneRepo(
  opts: RunBuildForRepoOptions,
): Promise<RunBuildForRepoResult> {
  const tasks = opts.tasksMarkdown ? parseTasks(opts.tasksMarkdown) : [];

  if (tasks.length === 0) {
    return runBuildFallback(opts);
  }

  opts.onProjectEvent?.(
    'info',
    `[build] ${opts.repoName}: ${tasks.length} task${tasks.length === 1 ? '' : 's'} (dep-graph scheduling)`,
  );

  const taskOutputs: TaskOutput[] = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;

  await runTasksWithDependencyGraph(
    tasks,
    async (task) => {
      if (opts.isCancelled()) throw new Error('Pipeline cancelled');
      const prompt = opts.buildPerTaskPrompt(task);
      // AgentRunner path: routes through chain-fallback + empty-throw
      // defense without per-task glue. The legacy spawnAndWait fallback
      // remains for callers that haven't migrated yet.
      if (opts.agentRunner) {
        const r = await opts.agentRunner.run({
          persona: opts.persona,
          projectPrompt: opts.projectPrompt,
          userPrompt: prompt,
          workingDir: opts.repoPath,
          stage: `${opts.stageName}:${opts.repoName}:${task.id}`,
          allowedTools: opts.allowedTools,
          disallowedTools: [...BUILD_DISALLOWED_TOOLS],
          maxOutputTokens: opts.maxOutputTokens,
          repoName: opts.repoName,
        });
        return {
          artifact: r.output,
          cost: r.costUsd ?? 0,
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          cacheReadTokens: r.cacheReadTokens ?? 0,
          cacheWriteTokens: r.cacheWriteTokens ?? 0,
        };
      }
      // Legacy direct-spawn path.
      if (!opts.agentManager) {
        throw new Error('runBuildForOneRepo requires either agentRunner or agentManager');
      }
      const result = await spawnAndWait({
        agentManager: opts.agentManager,
        spec: {
          name: `engineer-${opts.repoName}-${task.id}`,
          persona: opts.persona,
          project: opts.project,
          stage: `${opts.stageName}:${opts.repoName}:${task.id}`,
          prompt,
          model: opts.model ?? '',
          cwd: opts.repoPath,
          projectPrompt: opts.projectPrompt,
          permissionMode: 'bypassPermissions',
          disallowedTools: [...BUILD_DISALLOWED_TOOLS],
          allowedTools: opts.allowedTools,
          maxOutputTokens: opts.maxOutputTokens,
        },
        isCancelled: opts.isCancelled,
        onSpawn: opts.onAgentSpawned,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
      });
      return result;
    },
    {
      onStart: (task) => {
        opts.onProjectEvent?.(
          'info',
          `[build] ${opts.repoName} ${task.id} starting`,
        );
      },
      onComplete: (task, result) => {
        totalCost += result.cost;
        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        totalCacheReadTokens += result.cacheReadTokens;
        totalCacheWriteTokens += result.cacheWriteTokens;
        taskOutputs.push({ id: task.id, title: task.title, artifact: result.artifact });
        opts.onProjectEvent?.(
          'info',
          `[build] ${opts.repoName} ${task.id} done (${(result.cost * 100).toFixed(2)}¢)`,
        );
      },
      onFail: (task, err) => {
        const msg = err instanceof Error ? err.message : String(err);
        taskOutputs.push({
          id: task.id,
          title: task.title,
          artifact: unresolvedArtifact(task, msg),
        });
        opts.onProjectEvent?.('warn', `[build] ${opts.repoName} ${task.id} failed: ${msg}`);
      },
    },
    { enforceFileConflicts: true },
  );

  const combined = combineTaskArtifacts(tasks, taskOutputs);
  return {
    artifact: combined,
    cost: totalCost,
    taskCount: tasks.length,
    fallback: false,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheWriteTokens: totalCacheWriteTokens,
  };
}

async function runBuildFallback(
  opts: RunBuildForRepoOptions,
): Promise<RunBuildForRepoResult> {
  // AgentRunner path — preferred when supplied.
  if (opts.agentRunner) {
    const r = await opts.agentRunner.run({
      persona: opts.persona,
      projectPrompt: opts.projectPrompt,
      userPrompt: opts.buildFallbackPrompt(),
      workingDir: opts.repoPath,
      stage: `${opts.stageName}:${opts.repoName}`,
      allowedTools: opts.allowedTools,
      disallowedTools: [...BUILD_DISALLOWED_TOOLS],
      maxOutputTokens: opts.maxOutputTokens,
      repoName: opts.repoName,
    });
    return {
      artifact: r.output,
      cost: r.costUsd ?? 0,
      taskCount: 0,
      fallback: true,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
    };
  }
  if (!opts.agentManager) {
    throw new Error('runBuildFallback requires either agentRunner or agentManager');
  }
  const result = await spawnAndWait({
    agentManager: opts.agentManager,
    spec: {
      name: `${opts.persona}-${opts.repoName}`,
      persona: opts.persona,
      project: opts.project,
      stage: `${opts.stageName}:${opts.repoName}`,
      prompt: opts.buildFallbackPrompt(),
      model: opts.model ?? '',
      cwd: opts.repoPath,
      projectPrompt: opts.projectPrompt,
      permissionMode: 'bypassPermissions',
      disallowedTools: [...BUILD_DISALLOWED_TOOLS],
      allowedTools: opts.allowedTools,
      maxOutputTokens: opts.maxOutputTokens,
    },
    isCancelled: opts.isCancelled,
    onSpawn: opts.onAgentSpawned,
    onTruncation: opts.onTruncation,
    pollIntervalMs: opts.pollIntervalMs,
    sleep: opts.sleep,
  });
  return {
    artifact: result.artifact,
    cost: result.cost,
    taskCount: 0,
    fallback: true,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
  };
}

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
export function createPerRepoBuildStep(
  opts: PerRepoBuildStepOptions,
): Step<unknown, RunBuildForRepoResult> {
  const id = opts.id ?? `per-repo-build:${opts.stageName}`;

  return {
    id,
    name: `Per-repo build (${opts.stageName})`,
    parallelism: 'per-repo',

    async run(ctx: StepContext<unknown>): Promise<RunBuildForRepoResult> {
      const repoName = ctx.repoName;
      if (!repoName) {
        throw new Error(
          `[${id}] requires ctx.repoName — did the walker forget to fan out?`,
        );
      }
      const repoPath = ctx.repoPaths?.[repoName];
      if (!repoPath) {
        throw new Error(`[${id}] no repoPath registered for "${repoName}"`);
      }

      const isCancelled = opts.isCancelled
        ? () => opts.isCancelled!(ctx)
        : () => ctx.signal.aborted;

      const result = await runBuildForOneRepo({
        agentManager: opts.agentManager,
        project: opts.project,
        stageName: opts.stageName,
        persona: opts.persona,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        repoName,
        repoPath,
        projectPrompt: opts.buildProjectPrompt(repoName),
        tasksMarkdown: opts.loadTasksMarkdown(repoName),
        buildPerTaskPrompt: (task) => opts.buildPerTaskPrompt(repoName, repoPath, task),
        buildFallbackPrompt: () => opts.buildFallbackPrompt(repoName, repoPath),
        isCancelled,
        onAgentSpawned: opts.onAgentSpawned
          ? (agentId) => opts.onAgentSpawned!(repoName, agentId)
          : undefined,
        onTruncation: opts.onTruncation,
        onProjectEvent: opts.onProjectEvent
          ? (level, message) => opts.onProjectEvent!(repoName, level, message)
          : undefined,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
      });

      opts.writeRepoArtifact?.(repoName, result.artifact);

      return result;
    },
  };
}
