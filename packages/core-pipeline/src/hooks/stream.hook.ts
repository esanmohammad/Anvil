/**
 * Stream hook — debounced snapshot delta callback.
 *
 * Same snapshot shape as `attachDashboardStateHook` (which writes the
 * snapshot to a file), but pushes each debounced snapshot into a
 * caller-supplied `onSnapshot` callback. Use this from the dashboard
 * to broadcast pipeline state to WS clients without going through the
 * file system on the hot path.
 *
 * Subscribes to: `pipeline:started`, `pipeline:completed`,
 * `pipeline:failed`, `step:started`, `step:completed`, `step:failed`,
 * `step:skipped`. The skipped step is added to `completedStepIds` so
 * resume / rewind flows still produce coherent rollups.
 */

import type { EventBus, EventListener, PipelineEvent } from '../types.js';
import type { DashboardStateSnapshot } from './dashboard-state.hook.js';

/** Re-export for callers who want to type their `onSnapshot` arg. */
export type StreamSnapshot = DashboardStateSnapshot;

export interface StreamHookOptions {
  /**
   * Receives the most recent snapshot after each debounce window.
   * Called synchronously on the timer firing — keep it cheap (the
   * dashboard-typical use is "JSON.stringify + ws.send").
   */
  onSnapshot: (snapshot: StreamSnapshot) => void;
  /** Debounce window in ms. Default 100. */
  debounceMs?: number;
  /** Override priority. Default 10. */
  priority?: number;
  /** Optional error sink. Defaults to swallow (matches dashboard-state). */
  onError?: (err: unknown) => void;
  /** Test seam — defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Test seam — defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

export interface StreamHookHandle {
  unsubscribe: () => void;
  /** Force-flush any pending debounced snapshot. */
  flush: () => void;
  /** Number of snapshots delivered to the callback. */
  readonly deliverCount: number;
  /** Latest in-memory snapshot (may differ from last delivered if a flush is pending). */
  readonly snapshot: StreamSnapshot | undefined;
}

const HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:started',
  'pipeline:completed',
  'pipeline:failed',
  'step:started',
  'step:completed',
  'step:failed',
  'step:skipped',
];

export function attachStreamHook(
  bus: EventBus,
  opts: StreamHookOptions,
): StreamHookHandle {
  const debounceMs = opts.debounceMs ?? 100;
  const priority = opts.priority ?? 10;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const onError = opts.onError ?? (() => {});

  let snapshot: StreamSnapshot | undefined;
  let pending: unknown;
  let deliverCount = 0;

  const deliverNow = (): void => {
    pending = undefined;
    if (!snapshot) return;
    try {
      // Hand a frozen copy out — callers that mutate are likely buggy.
      opts.onSnapshot({ ...snapshot, completedStepIds: [...snapshot.completedStepIds] });
      deliverCount += 1;
    } catch (err) {
      onError(err);
    }
  };

  const schedule = (): void => {
    if (pending !== undefined) clearTimer(pending);
    pending = setTimer(deliverNow, debounceMs);
  };

  const update = (mutator: (snap: StreamSnapshot) => StreamSnapshot): void => {
    const seed: StreamSnapshot = snapshot ?? {
      runId: '',
      status: 'running',
      completedStepIds: [],
    };
    snapshot = mutator(seed);
    schedule();
  };

  const listener: EventListener = (event) => {
    switch (event.hook) {
      case 'pipeline:started':
        update(() => ({
          runId: event.runId,
          status: 'running',
          completedStepIds: [],
          lastEventTs: event.ts,
        }));
        break;
      case 'pipeline:completed':
        update((snap) => ({ ...snap, status: 'completed', lastEventTs: event.ts }));
        break;
      case 'pipeline:failed':
        update((snap) => ({ ...snap, status: 'failed', lastEventTs: event.ts }));
        break;
      case 'step:started':
        update((snap) => ({ ...snap, currentStepId: event.stepId, lastEventTs: event.ts }));
        break;
      case 'step:completed':
      case 'step:skipped':
        update((snap) => ({
          ...snap,
          completedStepIds: event.stepId ? [...snap.completedStepIds, event.stepId] : snap.completedStepIds,
          currentStepId: undefined,
          lastEventTs: event.ts,
        }));
        break;
      case 'step:failed':
        update((snap) => ({
          ...snap,
          failedStepId: event.stepId,
          currentStepId: undefined,
          lastEventTs: event.ts,
        }));
        break;
      default:
        break;
    }
  };

  const offs = HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
      if (pending !== undefined) clearTimer(pending);
    },
    flush: () => {
      if (pending !== undefined) {
        clearTimer(pending);
        deliverNow();
      }
    },
    get deliverCount() {
      return deliverCount;
    },
    get snapshot() {
      return snapshot;
    },
  };
}
