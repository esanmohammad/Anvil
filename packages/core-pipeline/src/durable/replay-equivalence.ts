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
 * Durable-write operations that are NOT outbound side effects (they
 * persist to the durable log) and therefore must NOT trip a replay
 * throwingSpy. Per ADR §4.5: a partial flush or invalidation happening
 * during replay is bookkeeping, not a re-executed effect. A spy created
 * with `allow: DURABLE_WRITE_OPS` passes these through when invoked with
 * the op name as the first argument.
 */
export const DURABLE_WRITE_OPS = [
  'flushPartial',
  'invalidatePartials',
  'appendAssistantPartial',
] as const;

export interface ThrowingSpyOptions {
  /** Op names (matched against the spy's first string arg) that pass
   *  through silently instead of throwing. */
  allow?: readonly string[];
  message?: string;
}

/**
 * A spy that throws when called. Used as a stand-in for a runner /
 * writer in pass-2 of a replay-equivalence test — if the stage
 * hits the spy, the effect was NOT replayed, which is a regression.
 *
 * Pass a string for a custom message (back-compat) or an options object
 * to whitelist durable-write op names (§4.5) — e.g.
 * `throwingSpy({ allow: DURABLE_WRITE_OPS })`. When whitelisting, the
 * spy treats its first argument as the operation name.
 */
export function throwingSpy<Args extends unknown[], R>(
  opts: string | ThrowingSpyOptions = {},
): (...args: Args) => Promise<R> {
  const o = typeof opts === 'string' ? { message: opts } : opts;
  const allow = new Set(o.allow ?? []);
  const message = o.message
    ?? 'replay-equivalence: outbound call should have been replayed from the durable log';
  return (...args: Args): Promise<R> => {
    const first = args[0];
    if (typeof first === 'string' && allow.has(first)) {
      return Promise.resolve(undefined as R);
    }
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
