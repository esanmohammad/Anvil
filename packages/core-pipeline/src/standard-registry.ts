/**
 * `buildStandardStepRegistry` — assembles an `InMemoryStepRegistry` with
 * one `Step` per entry in `STAGES`. Each step delegates to a caller-
 * supplied `runStage(stageName, prevArtifact, ctx)` callback that owns
 * the per-stage body (agent spawn, prompt building, fix-loop, ...).
 *
 * Both cli and dashboard build their pipeline registry through this
 * factory so the canonical `STAGES` array is the only source of truth
 * for stage order, naming, and per-repo fan-out hints.
 *
 * What this factory adds vs `STAGES`:
 *   - Wires a `Step.skipIf` predicate per stage (caller-injected) — used
 *     by the dashboard's planSeed flow (`PLAN_DERIVED_STAGES` skip set).
 *     See Phase A1.
 *   - Threads `stage.label` into `Step.name` so audit logs / UI labels
 *     stay consistent across consumers.
 *   - Leaves `parallelism: 'serial'` for now — the dashboard's
 *     pipeline-runner still owns per-repo fanout inside `runStage`.
 *     A future revision can flip this to `'per-repo'` for stages with
 *     `stage.perRepo === true` and let the walker drive the fanout
 *     (see `pipeline.ts:runPerRepoFanout`).
 *
 * Public name was `buildPipelineStepRegistry` while it lived in the
 * dashboard. The dashboard exports the new name AND keeps the old name
 * as a deprecated alias so any in-flight branch still builds.
 */

import { InMemoryStepRegistry } from './step-registry.js';
import { STAGES } from './stages/registry.js';
import type { Step, StepContext, StepRegistry, StepSkipContext } from './types.js';

/** Result returned by the per-stage runner. Cost is in USD. */
export interface RunStageResult {
  artifact: string;
  cost: number;
}

/**
 * Caller-supplied stage runner. Invoked once per stage in registry
 * order; receives the previous stage's artifact (string) and is
 * expected to return the new artifact + the stage's USD cost.
 *
 * The `ctx` parameter is the `StepContext` the walker built — useful
 * for callers that want to read `ctx.shared` / `ctx.bus` / `ctx.signal`
 * without going through closures.
 */
export type RunStageFn = (
  stageName: string,
  prevArtifact: string,
  ctx: StepContext<string>,
) => Promise<RunStageResult>;

export interface StandardRegistryDeps {
  /** Per-stage delegate. See `RunStageFn`. */
  runStage: RunStageFn;
  /**
   * Optional per-stage skip predicate map. When a stage's predicate
   * returns true, the walker emits `step:skipped` with `reason: 'skipIf'`
   * and threads the previous stage's output unchanged. Phase A1
   * primitive — the dashboard wires `planSeed` skip via this map.
   *
   * Stages not present in the map run unconditionally (subject to
   * `resumeFromStep` / `completedSteps` / `rewindTo` only).
   */
  skipIfByStage?: Partial<Record<string, (ctx: StepSkipContext) => boolean | Promise<boolean>>>;
  /**
   * Optional retry policy applied to every stage. Apply per-stage
   * tweaks by overriding `Step.retryPolicy` on the registry after
   * `buildStandardStepRegistry` returns.
   */
  retryPolicy?: Step<unknown, unknown>['retryPolicy'];
}

export function buildStandardStepRegistry(deps: StandardRegistryDeps): StepRegistry {
  const registry = new InMemoryStepRegistry();

  for (const stage of STAGES) {
    const skipIf = deps.skipIfByStage?.[stage.name];
    const step: Step<string, string> = {
      id: stage.name,
      name: stage.label,
      parallelism: 'serial',
      ...(skipIf ? { skipIf } : {}),
      ...(deps.retryPolicy ? { retryPolicy: deps.retryPolicy } : {}),
      run: async (ctx: StepContext<string>): Promise<string> => {
        const prevArtifact = ctx.input ?? '';
        const result = await deps.runStage(stage.name, prevArtifact, ctx);
        return result.artifact;
      },
    };
    registry.register(step as Step<unknown, unknown>);
  }

  return registry;
}
