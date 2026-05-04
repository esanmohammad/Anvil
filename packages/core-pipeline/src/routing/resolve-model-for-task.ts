/**
 * Per-task model resolution + dispatch ordering.
 *
 * Layered on top of resolveModelForStage:
 *   - Honors task.routing.preferred_tier when set (promotes that tier
 *     to the front of the chain).
 *   - Falls through to the stage policy when the task has no preference.
 *
 * Plus a topological-sort helper that orders tasks by `depends_on`
 * then `priority` (P0 first), so the build dispatcher knows what
 * to run when.
 */

import type { ModelTier, ResolvedChain } from '@anvil/agent-core';
import { loadModelRegistry, resolveModel } from '@anvil/agent-core';
import { loadStagePolicy } from './load-stage-policy.js';
import {
  UnknownStageError,
  resolveModelForStage,
  type ResolveModelForStageOptions,
} from './resolve-model-for-stage.js';
import type { TaskEnvelope, TaskPriority } from './task-envelope.js';

const PRIORITY_RANK: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2 };

export interface ResolveModelForTaskOptions extends ResolveModelForStageOptions {
  /** Stage to use as fallback when the task has no per-task preference.
   *  Defaults to 'build' since per-task routing is meaningful inside
   *  the build stage. */
  stage?: string;
}

/**
 * Resolve a model for one task. When the task supplies a
 * `routing.preferred_tier`, the chain is rebuilt with that tier first.
 * Otherwise this delegates to resolveModelForStage with the stage's
 * own policy.
 */
export function resolveModelForTask(
  task: TaskEnvelope,
  opts: ResolveModelForTaskOptions = {},
): ResolvedChain {
  const stage = opts.stage ?? 'build';
  const preferred = task.routing.preferred_tier;

  if (!preferred) return resolveModelForStage(stage, opts);

  // Build a fresh chain with the task's preferred tier first; the
  // stage's regular `prefer` order follows behind. The resolver and
  // registry are loaded fresh here (not via the stage cache) so this
  // call doesn't compete with the synchronous stage path.
  const policy = loadStagePolicy({ workspaceRoot: opts.workspaceRoot, env: opts.env });
  const stagePolicy = policy.stages[stage];
  if (!stagePolicy) throw new UnknownStageError(stage, Object.keys(policy.stages));

  const reordered: ModelTier[] = [
    preferred,
    ...stagePolicy.prefer.filter((t) => t !== preferred),
  ];

  const registry = loadModelRegistry({ workspaceRoot: opts.workspaceRoot, env: opts.env });
  return resolveModel(
    {
      capability: task.routing.capability,
      complexity: task.routing.complexity,
      prefer: reordered,
      minContextTokens: opts.minContextTokens,
    },
    registry,
  );
}

// ───────────────────────────────────────────────────────────────────────
// Dispatch ordering
// ───────────────────────────────────────────────────────────────────────

export interface OrderedTaskBatch {
  /** Tasks whose dependencies are all satisfied at this layer. */
  layer: TaskEnvelope[];
}

export class TaskCycleError extends Error {
  readonly remainingIds: string[];
  constructor(remainingIds: string[]) {
    super(`Task dependency cycle detected — remaining ids cannot be ordered: ${remainingIds.join(', ')}`);
    this.name = 'TaskCycleError';
    this.remainingIds = remainingIds;
  }
}

/**
 * Topological sort of tasks honoring `depends_on`, breaking ties by
 * `priority` (P0 → P1 → P2). Within a priority bucket, ties broken by
 * the planner's insertion order — that's the secondary signal the
 * planner used.
 *
 * Throws TaskCycleError if a cycle exists. Unknown task ids in
 * `depends_on` are filtered out (the planner's referent doesn't exist;
 * treat it as a no-op dep) so a malformed plan doesn't block dispatch.
 */
export function orderTasksForDispatch(tasks: TaskEnvelope[]): OrderedTaskBatch[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const remaining = new Set(tasks.map((t) => t.id));
  const completed = new Set<string>();
  const layers: OrderedTaskBatch[] = [];

  while (remaining.size > 0) {
    const layer: TaskEnvelope[] = [];
    for (const id of remaining) {
      const task = byId.get(id)!;
      const deps = (task.depends_on ?? []).filter((d) => byId.has(d));
      if (deps.every((d) => completed.has(d))) layer.push(task);
    }
    if (layer.length === 0) {
      throw new TaskCycleError([...remaining]);
    }
    layer.sort((a, b) => {
      const ap = PRIORITY_RANK[a.priority ?? 'P1'];
      const bp = PRIORITY_RANK[b.priority ?? 'P1'];
      return ap - bp;
    });
    for (const t of layer) {
      remaining.delete(t.id);
      completed.add(t.id);
    }
    layers.push({ layer });
  }
  return layers;
}
