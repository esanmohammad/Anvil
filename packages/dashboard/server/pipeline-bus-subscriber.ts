/**
 * Pipeline bus subscriber — dashboard-side translator for `@anvil/core-pipeline`
 * lifecycle events.
 *
 * Subscribes to the `EventBus` and rebuilds the dashboard's `DashboardState`
 * snapshot in-memory as `pipeline:*` / `step:*` events arrive, then broadcasts
 * `{ type: 'state', payload }` to WebSocket clients via the supplied
 * `broadcast` callback. The wire shape is unchanged — D10 invariant.
 *
 * For in-process pipeline runs (when `dashboard-server.ts` owns the bus)
 * this is the primary path. For cross-process runs (cli writes
 * `~/.anvil/state.json` from another process), the dashboard's existing
 * `fs.watch` + 1s polling fallback keeps working alongside this subscriber.
 *
 * Phase 2 of the dashboard consolidation. See DASHBOARD-CONSOLIDATION-PLAN.md.
 */

import type { EventBus, EventListener, PipelineEvent } from '@anvil/core-pipeline';
import type {
  DashboardState,
  DashboardPipeline,
  DashboardStageState,
  ServerMessage,
} from './dashboard-server.js';

// ── Public types ─────────────────────────────────────────────────────────

/**
 * Step descriptor known to the subscriber up front. The subscriber pre-builds
 * `stages[]` from this list so the UI shows every stage in pending state from
 * the moment the pipeline starts. Order matters — it defines `stepId → index`.
 */
export interface PipelineStepDescriptor {
  id: string;
  name: string;
  label?: string;
  perRepo?: boolean;
}

export interface PipelineBusSubscriberOptions {
  /** Project + feature header for the in-memory snapshot. */
  project: string;
  feature: string;
  featureSlug?: string;
  /** Model id to surface on the snapshot. */
  model?: string;
  /** Repo names for per-repo aware stages. */
  repoNames?: string[];
  /** Ordered step descriptors. Empty list is allowed for Phase 2 wiring. */
  steps: ReadonlyArray<PipelineStepDescriptor>;
  /** WS broadcaster — typically dashboard-server's `broadcast(msg)`. */
  broadcast: (msg: ServerMessage) => void;
  /** Override priority. Default 10 (after audit + learners). */
  priority?: number;
}

export interface PipelineBusSubscriberHandle {
  unsubscribe: () => void;
  /** Latest snapshot the subscriber has built. */
  snapshot(): DashboardState;
  /** Number of `state` messages broadcast so far. */
  readonly broadcastCount: number;
}

// ── Implementation ───────────────────────────────────────────────────────

const HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:started',
  'pipeline:completed',
  'pipeline:failed',
  'step:started',
  'step:completed',
  'step:failed',
  'step:retried',
];

export function attachPipelineBusSubscriber(
  bus: EventBus,
  opts: PipelineBusSubscriberOptions,
): PipelineBusSubscriberHandle {
  const priority = opts.priority ?? 10;
  const stepIndex = buildStepIndex(opts.steps);
  let runId = '';
  let totalCost = 0;
  let broadcastCount = 0;

  const stages: DashboardStageState[] = opts.steps.map((s) => ({
    name: s.name,
    label: s.label ?? s.name,
    status: 'pending',
    cost: 0,
    perRepo: s.perRepo,
    repos: s.perRepo && opts.repoNames?.length
      ? opts.repoNames.map((repoName) => ({
          repoName,
          agentId: null,
          status: 'pending',
          cost: 0,
          error: null,
        }))
      : undefined,
  }));

  let pipeline: DashboardPipeline = {
    runId: '',
    project: opts.project,
    feature: opts.feature,
    featureSlug: opts.featureSlug,
    status: 'idle',
    currentStage: 0,
    stages,
    startedAt: new Date(0).toISOString(),
    cost: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    model: opts.model,
    repoNames: opts.repoNames,
    waitingForInput: false,
  };

  const snapshot = (): DashboardState => ({
    activePipeline: pipeline.runId ? pipeline : null,
    lastUpdated: new Date().toISOString(),
  });

  const broadcastSnapshot = (): void => {
    opts.broadcast({ type: 'state', payload: snapshot() });
    broadcastCount += 1;
  };

  const indexOf = (stepId: string | undefined): number => {
    if (!stepId) return -1;
    const idx = stepIndex.get(stepId);
    return idx ?? -1;
  };

  const updateStageAt = (
    idx: number,
    mutate: (stage: DashboardStageState) => DashboardStageState,
  ): void => {
    if (idx < 0 || idx >= pipeline.stages.length) return;
    pipeline.stages[idx] = mutate(pipeline.stages[idx]);
  };

  const listener: EventListener = (event) => {
    switch (event.hook) {
      case 'pipeline:started':
        runId = event.runId;
        totalCost = 0;
        pipeline = {
          ...pipeline,
          runId,
          status: 'running',
          currentStage: 0,
          startedAt: event.ts,
          cost: { ...pipeline.cost, estimatedCost: 0 },
          stages: pipeline.stages.map((s) => ({ ...s, status: 'pending', cost: 0 })),
        };
        broadcastSnapshot();
        break;

      case 'pipeline:completed':
        pipeline = { ...pipeline, status: 'completed' };
        broadcastSnapshot();
        break;

      case 'pipeline:failed':
        pipeline = { ...pipeline, status: 'failed' };
        broadcastSnapshot();
        break;

      case 'step:started': {
        const idx = indexOf(event.stepId);
        if (idx >= 0) {
          updateStageAt(idx, (stage) => ({
            ...stage,
            status: 'running',
            startedAt: event.ts,
          }));
          pipeline = { ...pipeline, currentStage: idx };
        }
        broadcastSnapshot();
        break;
      }

      case 'step:completed': {
        const idx = indexOf(event.stepId);
        const cost = readCost(event);
        if (idx >= 0) {
          updateStageAt(idx, (stage) => ({
            ...stage,
            status: 'completed',
            completedAt: event.ts,
            cost: (stage.cost ?? 0) + cost,
          }));
        }
        if (cost > 0) {
          totalCost += cost;
          pipeline = {
            ...pipeline,
            cost: { ...pipeline.cost, estimatedCost: totalCost },
          };
        }
        broadcastSnapshot();
        break;
      }

      case 'step:failed': {
        const idx = indexOf(event.stepId);
        if (idx >= 0) {
          const errMsg = event.error?.message ?? 'unknown error';
          updateStageAt(idx, (stage) => ({
            ...stage,
            status: 'failed',
            completedAt: event.ts,
            error: errMsg,
          }));
        }
        broadcastSnapshot();
        break;
      }

      case 'step:retried':
        // Keep status as running across retries — UI shows the live attempt
        // through agent-output entries rather than a separate state field.
        break;

      default:
        break;
    }
  };

  const offs = HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
    },
    snapshot,
    get broadcastCount() {
      return broadcastCount;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildStepIndex(steps: ReadonlyArray<PipelineStepDescriptor>): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < steps.length; i += 1) map.set(steps[i].id, i);
  return map;
}

/**
 * Read `costUsd` from a `step:completed` payload, consistent with how
 * core-pipeline's `cost-tracker.hook` reads it. Returns 0 when missing or
 * non-finite so totals never go NaN.
 */
function readCost(event: PipelineEvent): number {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return 0;
  const direct = payload.costUsd;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  const nested = payload.data as Record<string, unknown> | undefined;
  if (nested && typeof nested.costUsd === 'number' && Number.isFinite(nested.costUsd) && nested.costUsd > 0) {
    return nested.costUsd as number;
  }
  return 0;
}
