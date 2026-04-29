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
  /** Sum across every step. */
  totals(): { costUsd: number; entries: number };
  /** Per-step breakdown. */
  byStep(): ReadonlyMap<string, number>;
  /**
   * Manually attribute a cost to a step (e.g., when the LLM router records
   * spend outside the bus).
   */
  record(stepId: string, costUsd: number): void;
}

export function attachCostTrackerHook(bus: EventBus, opts: CostTrackerHookOptions = {}): CostTrackerHookHandle {
  const priority = opts.priority ?? 20;
  const perStep = new Map<string, number>();
  let total = 0;
  let entries = 0;

  const record = (stepId: string, costUsd: number): void => {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    perStep.set(stepId, (perStep.get(stepId) ?? 0) + costUsd);
    total += costUsd;
    entries += 1;
  };

  const listener: EventListener = (event) => {
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
    totals: () => ({ costUsd: total, entries }),
    byStep: () => new Map(perStep),
    record,
  };
}

function readCostUsd(event: PipelineEvent): number | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  const direct = payload.costUsd;
  if (typeof direct === 'number') return direct;
  const nested = payload.data as Record<string, unknown> | undefined;
  if (nested && typeof nested.costUsd === 'number') return nested.costUsd;
  return undefined;
}
