/**
 * Replay-equivalence test seam — Phase E0.
 *
 * Per-stage conversion phases each ship a pair of tests:
 *   1. Live recording — run the stage with effects firing; capture
 *      the durable log.
 *   2. Replay — re-run the stage against the captured log; assert
 *      no outbound calls + identical output.
 *
 * `seedStoreFromLog` is the inverse of "extract every event from
 * pass-1's store"; it lets pass-2 start from the captured state
 * without persisting to disk between runs.
 *
 * `recordingSpy<T>(throwOnCall)` returns a callable that the test
 * passes wherever a real runner / writer would go; in pass-2 the
 * spy throws if invoked, proving the effect was replayed.
 */

import type { DurableStore } from './store.js';
import type { EventRecord } from './types.js';

/**
 * Replays a captured event log into a fresh `DurableStore` for the
 * same `runId`. Used by pass-2 of replay-equivalence tests.
 *
 * Caller MUST have already called `store.createRun(...)` with the
 * same `runId` before invoking this — the events FK to the run row.
 */
export async function seedStoreFromLog(
  store: DurableStore,
  events: ReadonlyArray<EventRecord>,
): Promise<void> {
  // Group by runId in case the caller passed a multi-run log.
  const byRun = new Map<string, EventRecord[]>();
  for (const ev of events) {
    if (!byRun.has(ev.runId)) byRun.set(ev.runId, []);
    byRun.get(ev.runId)!.push(ev);
  }
  for (const [, runEvents] of byRun) {
    await store.appendBatch(
      runEvents.map((ev) => ({
        runId: ev.runId,
        kind: ev.kind,
        stepId: ev.stepId ?? null,
        effectKey: ev.effectKey ?? null,
        effectIdx: ev.effectIdx ?? null,
        payload: ev.payload,
        ts: ev.ts,
      })),
    );
  }
}

/**
 * A spy that throws when called. Used as a stand-in for a runner /
 * writer in pass-2 of a replay-equivalence test — if the stage
 * hits the spy, the effect was NOT replayed, which is a regression.
 */
export function throwingSpy<Args extends unknown[], R>(
  message = 'replay-equivalence: outbound call should have been replayed from the durable log',
): (...args: Args) => Promise<R> {
  return (..._args: Args): Promise<R> => {
    throw new Error(message);
  };
}

/**
 * Counting spy — like `throwingSpy` but records call counts so a
 * test can assert "was called N times in pass-1, 0 times in pass-2"
 * without bailing the run.
 */
export interface CountingSpy<Args extends unknown[], R> {
  fn: (...args: Args) => Promise<R>;
  callCount: number;
  reset: () => void;
}

export function countingSpy<Args extends unknown[], R>(
  result: R | ((...args: Args) => Promise<R>),
): CountingSpy<Args, R> {
  let count = 0;
  const fn = (...args: Args): Promise<R> => {
    count += 1;
    if (typeof result === 'function') {
      return (result as (...a: Args) => Promise<R>)(...args);
    }
    return Promise.resolve(result);
  };
  return {
    fn,
    get callCount() {
      return count;
    },
    reset: () => {
      count = 0;
    },
  };
}
