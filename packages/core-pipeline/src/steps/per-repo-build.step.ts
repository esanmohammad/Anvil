/**
 * `per-repo-build` step factory.
 *
 * Phase H10 — promoted from
 * `packages/dashboard/server/steps/per-repo-build.step.ts` into
 * `core-pipeline/src/steps`. Refactored to require an `AgentRunner`
 * (legacy AgentManager fallback dropped from canonical).
 */

import type { Step, StepContext } from '../types.js';
import type { AgentRunner } from '../agent-runner.js';
import {
  parseTasks,
  runTasksWithDependencyGraph,
  type ParsedTask,
} from '../utils/engineer-task-bundler.js';

/**
 * Per-task disallowedTools: every file is pre-bundled into the prompt,
 * so Read/Grep/Glob are blocked alongside Agent.
 */
export const BUILD_DISALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Agent'];

export interface RunBuildForRepoOptions {
  runner: AgentRunner;
  project: string;
  stageName: string;
  persona: string;
  model?: string;
  maxOutputTokens?: number;
  repoName: string;
  repoPath: string;
  projectPrompt: string;
  tasksMarkdown: string;
  buildPerTaskPrompt: (task: ParsedTask) => string;
  buildFallbackPrompt: () => string;
  isCancelled: () => boolean;
  onProjectEvent?: (level: 'info' | 'warn', message: string) => void;
  allowedTools?: string[];
  /**
   * Phase F2 — optional per-task effect wrapper. When provided,
   * every per-task spawn flows through this function so the
   * caller can wrap it in `ctx.effect(name, fn)` for durable
   * checkpointing. The signature is `(taskId, fn) => Promise<R>`
   * — the callee just calls `fn()` and returns the result; the
   * wrapper is responsible for the durable record.
   *
   * On replay, the wrapper returns the recorded result without
   * invoking `fn`, so a build that completed tasks 1..N before a
   * crash skips them on resume; only the un-recorded tail re-runs.
   *
   * Pass `(_, fn) => fn()` for a no-op (legacy behaviour).
   */
  wrapTaskRun?: <R>(taskId: string, fn: () => Promise<R>) => Promise<R>;
}

export interface RunBuildForRepoResult {
  artifact: string;
  cost: number;
  taskCount: number;
  fallback: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface TaskOutput {
  id: string;
  title: string;
  artifact: string;
}

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

function unresolvedArtifact(task: ParsedTask, message: string): string {
  return `## Implementation: ${task.id} — ${task.title}\n\nUNRESOLVED: ${message}\n`;
}

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
      const runOnce = async () => opts.runner.run({
        persona: opts.persona,
        projectPrompt: opts.projectPrompt,
        userPrompt: prompt,
        workingDir: opts.repoPath,
        stage: `${opts.stageName}:${opts.repoName}:${task.id}`,
        allowedTools: opts.allowedTools,
        disallowedTools: [...BUILD_DISALLOWED_TOOLS],
        maxOutputTokens: opts.maxOutputTokens,
        model: opts.model,
        repoName: opts.repoName,
      });
      // Phase F2: per-task durable wrap. The dashboard's
      // pipeline-stages caller passes a wrapper that records
      // each task spawn under
      // `build:spawn-task-<repo>-<taskId>` so a crash mid-build
      // resumes per-task on replay.
      const r = opts.wrapTaskRun
        ? await opts.wrapTaskRun(task.id, runOnce)
        : await runOnce();
      return {
        artifact: r.output,
        cost: r.costUsd ?? 0,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        cacheReadTokens: r.cacheReadTokens ?? 0,
        cacheWriteTokens: r.cacheWriteTokens ?? 0,
      };
    },
    {
      onStart: (task) => {
        opts.onProjectEvent?.('info', `[build] ${opts.repoName} ${task.id} starting`);
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

  return {
    artifact: combineTaskArtifacts(tasks, taskOutputs),
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
  const r = await opts.runner.run({
    persona: opts.persona,
    projectPrompt: opts.projectPrompt,
    userPrompt: opts.buildFallbackPrompt(),
    workingDir: opts.repoPath,
    stage: `${opts.stageName}:${opts.repoName}`,
    allowedTools: opts.allowedTools,
    disallowedTools: [...BUILD_DISALLOWED_TOOLS],
    maxOutputTokens: opts.maxOutputTokens,
    model: opts.model,
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

export interface PerRepoBuildStepOptions {
  id?: string;
  runner: AgentRunner;
  project: string;
  stageName: string;
  persona: string;
  model: string;
  maxOutputTokens?: number;
  buildProjectPrompt: (repoName: string) => string;
  loadTasksMarkdown: (repoName: string) => string;
  buildPerTaskPrompt: (repoName: string, repoPath: string, task: ParsedTask) => string;
  buildFallbackPrompt: (repoName: string, repoPath: string) => string;
  onProjectEvent?: (repoName: string, level: 'info' | 'warn', message: string) => void;
  writeRepoArtifact?: (repoName: string, artifact: string) => void;
  isCancelled?: (ctx: StepContext<unknown>) => boolean;
  allowedTools?: string[];
}

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
        throw new Error(`[${id}] requires ctx.repoName`);
      }
      const repoPath = ctx.repoPaths?.[repoName];
      if (!repoPath) {
        throw new Error(`[${id}] no repoPath for "${repoName}"`);
      }
      const isCancelled = opts.isCancelled
        ? () => opts.isCancelled!(ctx)
        : () => ctx.signal.aborted;
      const result = await runBuildForOneRepo({
        runner: opts.runner,
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
        onProjectEvent: opts.onProjectEvent
          ? (level, message) => opts.onProjectEvent!(repoName, level, message)
          : undefined,
        allowedTools: opts.allowedTools,
      });
      opts.writeRepoArtifact?.(repoName, result.artifact);
      return result;
    },
  };
}
