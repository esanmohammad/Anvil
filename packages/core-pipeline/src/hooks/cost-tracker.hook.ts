/**
 * Cost-tracker hook — accumulates per-step and per-run cost.
 *
 * Subscribes to `artifact:emitted` events whose payload includes a
 * `costUsd` numeric field, and to `step:completed` events whose payload
 * carries a stage-level cost. The hook is read-only externally — exposes
 * `totals()` and `byStep()` for end-of-run summarization (PipelineRunResult.costUsd).
 */

import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface CostTrackerHookOptions {
  /** Override priority. Default 20. */
  priority?: number;
}

export interface CostTrackerHookHandle {
  unsubscribe: () => void;
  /**
   * Sum across every step. `byModel` + `prefillReinjectionUsd` populate
   * from §2.6 `step:completed.costByModel` once a stage is ported to the
   * turn-recorder; they stay empty/0 for legacy single-effect stages.
   */
  totals(): {
    costUsd: number;
    entries: number;
    prefillReinjectionUsd: number;
    byModel: ReadonlyMap<string, number>;
  };
  /** Per-step breakdown. */
  byStep(): ReadonlyMap<string, number>;
  /**
   * Manually attribute a cost to a step (e.g., when the LLM router records
   * spend outside the bus).
   */
  record(stepId: string, costUsd: number): void;
}

interface ModelCostShape {
  costUsd?: number;
}

export function attachCostTrackerHook(bus: EventBus, opts: CostTrackerHookOptions = {}): CostTrackerHookHandle {
  const priority = opts.priority ?? 20;
  const perStep = new Map<string, number>();
  const byModel = new Map<string, number>();
  let total = 0;
  let entries = 0;
  let prefillReinjectionUsd = 0;

  const record = (stepId: string, costUsd: number): void => {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    perStep.set(stepId, (perStep.get(stepId) ?? 0) + costUsd);
    total += costUsd;
    entries += 1;
  };

  const listener: EventListener = (event) => {
    // §2.6 per-model breakdown — only present on ported stages'
    // step:completed. Accumulates the model buckets + reinjection line.
    const payload = event.payload as Record<string, unknown> | undefined;
    const costByModel = payload?.costByModel;
    if (costByModel && typeof costByModel === 'object') {
      for (const [model, mc] of Object.entries(costByModel as Record<string, ModelCostShape>)) {
        const c = mc?.costUsd;
        if (typeof c === 'number' && Number.isFinite(c)) {
          byModel.set(model, (byModel.get(model) ?? 0) + c);
        }
      }
      const reinj = payload?.prefillReinjectionUsd;
      if (typeof reinj === 'number' && Number.isFinite(reinj)) prefillReinjectionUsd += reinj;
    }

    const cost = readCostUsd(event);
    if (cost === undefined || event.stepId === undefined) return;
    record(event.stepId, cost);
  };

  const offs: Array<() => void> = [
    bus.on('artifact:emitted', listener, { priority }),
    bus.on('step:completed', listener, { priority }),
  ];

  return {
    unsubscribe: () => {
      for (const off of offs) off();
    },
    totals: () => ({ costUsd: total, entries, prefillReinjectionUsd, byModel: new Map(byModel) }),
    byStep: () => new Map(perStep),
    record,
  };
}

function readCostUsd(event: PipelineEvent): number | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  // §2.6: a ported stage reports its authoritative per-model total here.
  // Prefer it over the legacy scalar so we don't under/over-count.
  const rollup = payload.totalCostUsd;
  if (typeof rollup === 'number') return rollup;
  const direct = payload.costUsd;
  if (typeof direct === 'number') return direct;
  const nested = payload.data as Record<string, unknown> | undefined;
  if (nested && typeof nested.costUsd === 'number') return nested.costUsd;
  return undefined;
}
