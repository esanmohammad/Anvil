/**
 * Durable-log hook — appends every step lifecycle event to a
 * `DurableStore`.
 *
 * This is the *primary* persistence consumer in Pattern 2 — if the
 * append fails, `bus.emit` rejects and the step body sees a thrown
 * error. The walker treats that as a fatal infrastructure error and
 * marks the run `cancelled` (with reason `'infra-error'`); it does
 * NOT mark the run `failed`, because failed implies user-fixable
 * code.
 *
 * Runs at priority 200 — above audit-log's 100 — so the durable
 * record lands before any other consumer sees the event. The
 * audit-log + dashboard-state hooks remain best-effort secondary
 * projections.
 *
 * Effect lifecycle events (`effect:started` / `effect:completed` /
 * `effect:failed`) are written DIRECTLY by the `EffectRuntime`, NOT
 * by this hook — they don't go through the EventBus because the
 * effect runtime needs deterministic ordering with respect to the
 * step body.
 */

import type { EventBus, EventListener, PipelineEvent, StepHookPoint } from '../types.js';
import type { DurableStore } from '../durable/store.js';
import type { DurableEventKind } from '../durable/types.js';

export interface DurableLogHookOptions {
  /** Override priority. Default 200. */
  priority?: number;
}

export interface DurableLogHookHandle {
  unsubscribe(): void;
  /** Number of events successfully persisted. */
  readonly entryCount: number;
}

const HOOK_TO_KIND: Partial<Record<StepHookPoint, DurableEventKind>> = {
  'step:started': 'step:started',
  'step:completed': 'step:completed',
  'step:failed': 'step:failed',
  'step:skipped': 'step:skipped',
};

const SUBSCRIBED: ReadonlyArray<StepHookPoint> = [
  'step:started',
  'step:completed',
  'step:failed',
  'step:skipped',
];

export function attachDurableLogHook(
  bus: EventBus,
  store: DurableStore,
  runId: string,
  opts: DurableLogHookOptions = {},
): DurableLogHookHandle {
  const priority = opts.priority ?? 200;
  let entryCount = 0;

  const listener: EventListener = async (event: PipelineEvent) => {
    if (event.runId !== runId) return;
    const kind = HOOK_TO_KIND[event.hook];
    if (!kind) return;
    await store.appendEvent({
      runId: event.runId,
      kind,
      stepId: event.stepId ?? null,
      payload: {
        payload: event.payload ?? null,
        error: event.error,
        ts: event.ts,
      },
    });
    entryCount += 1;
  };

  const offs = SUBSCRIBED.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
    },
    get entryCount() {
      return entryCount;
    },
  };
}
