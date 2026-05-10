/**
 * `pipeline-hooks` — bus subscription wiring extracted from `run()`.
 *
 * Attaches the canonical core-pipeline lifecycle hooks (audit log,
 * cost tracker, stream, checkpoint, rollup, liveness prefetch).
 * Returns a `detach()` thunk that flushes + unsubscribes everything
 * in one call.
 *
 * The dashboard's `step:skipped` listener (plan-derived artifact
 * rendering) lives in `pipeline-loop.ts` since it shares the loop's
 * `stageState.prevArtifact` slot.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  attachAuditLogHook,
  attachCheckpointHook,
  attachCostTrackerHook,
  attachDashboardStateRollupHook,
  attachLivenessPrefetchHook,
  attachStreamHook,
  createFileCheckpointStore,
  type EventBus,
} from '@esankhan3/anvil-core-pipeline';
import {
  type PipelineRunState,
} from './pipeline-runner-types.js';

export interface PipelineHooksDeps {
  bus: EventBus;
  state: PipelineRunState;
  broadcast: () => void;
  prefetchProviderLiveness: () => Promise<void>;
}

export interface PipelineHooksHandle {
  detach: () => void;
}

export function attachPipelineHooks(deps: PipelineHooksDeps): PipelineHooksHandle {
  const auditLogPath = join(
    process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil'),
    'runs',
    deps.state.runId,
    'audit.jsonl',
  );
  const auditLogHandle = attachAuditLogHook(deps.bus, { path: auditLogPath });
  const costTrackerHandle = attachCostTrackerHook(deps.bus);
  const streamHandle = attachStreamHook(deps.bus, {
    onSnapshot: () => deps.broadcast(),
    debounceMs: 100,
  });
  const checkpointHandle = attachCheckpointHook(deps.bus, {
    store: createFileCheckpointStore(),
    runId: deps.state.runId,
    keepOnSuccess: true,
    getShared: () => ({
      project: deps.state.project,
      feature: deps.state.feature,
      featureSlug: deps.state.featureSlug,
      totalCost: deps.state.totalCost,
      repoNames: deps.state.repoNames,
    }),
  });
  // Dashboard's RepoAgentState.error is `string | null`; canonical
  // DashboardRollupRepoState uses `string | undefined`. Cast through
  // `unknown` to bridge — the hook only writes `string` or deletes.
  const rollupHandle = attachDashboardStateRollupHook(deps.bus, {
    state: deps.state as unknown as Parameters<typeof attachDashboardStateRollupHook>[1]['state'],
    broadcast: () => deps.broadcast(),
    debounceMs: 50,
  });
  const livenessHandle = attachLivenessPrefetchHook(deps.bus, {
    probe: () => deps.prefetchProviderLiveness(),
    await: true,
  });

  return {
    detach: () => {
      auditLogHandle.unsubscribe();
      costTrackerHandle.unsubscribe();
      streamHandle.flush();
      streamHandle.unsubscribe();
      checkpointHandle.unsubscribe();
      livenessHandle.unsubscribe();
      rollupHandle.flush();
      rollupHandle.unsubscribe();
    },
  };
}
