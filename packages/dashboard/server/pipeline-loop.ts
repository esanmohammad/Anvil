/**
 * `pipeline-loop` — outer rewind-aware Pipeline.run() driver
 * extracted from `pipeline-runner.ts:run()`.
 *
 * Delegates each stage to `runOneStage` (in `pipeline-stages.ts`)
 * via a `runStage` callback on `buildStandardStepRegistry`, then
 * wraps the walker in a `do/while` so reviewer-triggered rewinds
 * (Pipeline.run({ rewindTo })) land cleanly.
 */
import {
  Pipeline,
  buildStandardStepRegistry,
  type EventBus,
} from '@esankhan3/anvil-core-pipeline';
import { runOneStage as runOneStageFn, type StageOpsDeps } from './pipeline-stages.js';
import { renderPlanDerivedArtifact as renderPlanDerivedArtifactBridge } from './manifest-bridge.js';
import {
  STAGES,
  PLAN_DERIVED_STAGES,
  type PipelineConfig,
} from './pipeline-runner-types.js';

export interface PipelineLoopOpts {
  stageOps: StageOpsDeps;
  bus: EventBus;
  runId: string;
  workspaceDir: string;
  repoPaths: () => Record<string, string>;
  config: PipelineConfig;
  isResume: boolean;
  resumeStage: number;
  initialPrevArtifact: string;
  isCancelled: () => boolean;
}

export interface PipelineLoopResult {
  prevArtifact: string;
  pipelineEarlyReturn: boolean;
}

export async function runPipelineLoop(opts: PipelineLoopOpts): Promise<PipelineLoopResult> {
  const stageState = {
    prevArtifact: opts.initialPrevArtifact,
    isResume: opts.isResume,
    resumeStage: opts.resumeStage,
  };
  let pipelineEarlyReturn = false;
  let rewindToStep: string | undefined;

  // Render plan-derived artifacts for stages skipped via skipIfByStage.
  // Lives here (not pipeline-hooks.ts) because it threads the rendered
  // artifact back into stageState.prevArtifact for the next stage.
  const planSkipUnsub = opts.bus.on('step:skipped', async (event) => {
    if (event.payload && (event.payload as { reason?: string }).reason !== 'skipIf') return;
    if (!event.stepId || !PLAN_DERIVED_STAGES.includes(event.stepId)) return;
    const stageIdx = STAGES.findIndex((s) => s.name === event.stepId);
    if (stageIdx < 0) return;
    await renderPlanDerivedArtifactBridge(opts.stageOps.depsForManifest(), event.stepId, stageIdx);
    const rendered = opts.stageOps.state.stages[stageIdx]?.artifact;
    if (rendered) stageState.prevArtifact = rendered;
  });

  while (true) {
    if (opts.isCancelled()) break;
    const registry = buildStandardStepRegistry({
      skipIfByStage: {
        requirements: () => opts.config.planSeed != null,
        'repo-requirements': () => opts.config.planSeed != null,
        specs: () => opts.config.planSeed != null,
        tasks: () => opts.config.planSeed != null,
      },
      runStage: async (stageName) => {
        const idx = STAGES.findIndex((s) => s.name === stageName);
        if (idx < 0) throw new Error(`Unknown stage in registry: ${stageName}`);
        const ctrl = await runOneStageFn(
          opts.stageOps, idx, stageState.isResume, stageState.resumeStage, stageState.prevArtifact,
        );
        stageState.prevArtifact = ctrl.prevArtifact;
        if (ctrl.control === 'cancelled') {
          const err = new Error('cancelled');
          (err as Error & { __anvilCancel: boolean }).__anvilCancel = true;
          throw err;
        }
        if (ctrl.control === 'fail-early-return') {
          const stageErr = opts.stageOps.state.stages[idx]?.error ?? 'unknown';
          const err = new Error(`fail-early-return: ${stageErr}`);
          (err as Error & { __anvilFailReturn: boolean }).__anvilFailReturn = true;
          throw err;
        }
        if (ctrl.control === 'rewind' && ctrl.rewindTo !== undefined) {
          const err = new Error('rewind');
          (err as Error & { __anvilRewind: number }).__anvilRewind = ctrl.rewindTo;
          throw err;
        }
        return { artifact: stageState.prevArtifact, cost: 0 };
      },
    });

    try {
      // Phase D — seed ctx.shared.planBinding so downstream stages can
      // verify build / validate / ship output against the approved plan.
      const initialShared: Record<string, unknown> = {};
      if (opts.config.planBinding) initialShared.planBinding = opts.config.planBinding;
      if (opts.config.planSeed) initialShared.planSeed = opts.config.planSeed;
      const pipeline = new Pipeline({
        registry,
        bus: opts.bus,
        runId: opts.runId,
        workspaceDir: opts.workspaceDir,
        initialInput: stageState.prevArtifact,
        repoPaths: opts.repoPaths(),
        initialShared,
        ...(rewindToStep ? { rewindTo: rewindToStep } : {}),
      });
      // Pipeline.run() returns `{status:'success'|'failed', ...}` and
      // does NOT re-throw on step failure — it emits `pipeline:failed`,
      // sets `status:'failed'` on its return value, and resolves
      // normally. Without checking the return value here, the runner
      // would fall through to its "set state.status = 'completed'"
      // branch and the UI would show a green "Pipeline completed"
      // sitting next to a red failed stage. Mirror the throw-based
      // control-flow markers (`__anvilFailReturn`) by setting
      // `pipelineEarlyReturn = true` on `status === 'failed'`.
      const result = await pipeline.run();
      if (result.status === 'failed') {
        pipelineEarlyReturn = true;
      }
      break;
    } catch (err) {
      const e = err as Error & {
        __anvilCancel?: boolean;
        __anvilFailReturn?: boolean;
        __anvilRewind?: number;
      };
      const msg = e?.message ?? String(err);
      if (e.__anvilCancel || msg.includes('cancelled')) break;
      if (e.__anvilFailReturn || msg.includes('fail-early-return')) {
        pipelineEarlyReturn = true;
        break;
      }
      if (e.__anvilRewind !== undefined || msg.includes('rewind')) {
        const target = e.__anvilRewind ?? -1;
        if (target < 0) break;
        const targetName = STAGES[target]?.name;
        if (!targetName) break;
        rewindToStep = targetName;
        continue;
      }
      throw err;
    }
  }

  planSkipUnsub();
  return { prevArtifact: stageState.prevArtifact, pipelineEarlyReturn };
}

