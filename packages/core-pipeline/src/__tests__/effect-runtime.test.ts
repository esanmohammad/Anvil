/**
 * Phase D2 — `EffectRuntime` replay equivalence + divergence detection.
 *
 * The runtime must:
 *   1. Live execution: record `effect:started` then `effect:completed`
 *      around each `ctx.effect(name, fn)` call.
 *   2. Replay: when prior events exist for `(stepId, name, idx)`,
 *      return the recorded result without invoking `fn()`.
 *   3. Divergence: throw `DeterminismViolationError` on
 *      effect-name / idx mismatches.
 *   4. Crashed mid-effect: when `effect:started` exists but no
 *      completion → re-run `fn()` and write a fresh `effect:completed`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import { EffectRuntime, ReplayedEffectError } from '../durable/effect-runtime.js';
import { DeterminismViolationError } from '../durable/types.js';

const NOW = 1_700_000_000_000;
const RUN_ID = 'run-effect';
const STEP = 's1';

async function newRuntime(opts: { withRecorded?: () => Promise<InMemoryDurableStore> } = {}) {
  const store = opts.withRecorded
    ? await opts.withRecorded()
    : new InMemoryDurableStore(() => NOW);
  if (!opts.withRecorded) {
    await store.createRun({ runId: RUN_ID, project: 'p', feature: 'f', featureSlug: 'f' });
  }
  const recorded = await store.readEffectEvents(RUN_ID, STEP);
  const runtime = new EffectRuntime({
    store,
    runId: RUN_ID,
    stepId: STEP,
    recordedEffects: recorded,
    realNow: () => NOW,
    realSleep: async () => undefined,
  });
  return { store, runtime };
}

describe('EffectRuntime — live execution', () => {
  it('records started + completed around ctx.effect', async () => {
    const { store, runtime } = await newRuntime();
    const out = await runtime.effect('hello', async () => 42);
    assert.equal(out, 42);
    const events = await store.readEvents(RUN_ID);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'effect:started');
    assert.equal(events[1].kind, 'effect:completed');
    assert.equal(events[1].payload, 42);
  });

  it('idx increments across multiple calls', async () => {
    const { store, runtime } = await newRuntime();
    await runtime.effect('a', async () => 1);
    await runtime.effect('a', async () => 2);
    const pairs = await store.readEffectEvents(RUN_ID, STEP);
    assert.deepEqual(pairs.map((p) => p.started.effectIdx), [0, 1]);
    assert.deepEqual(pairs.map((p) => p.completed?.payload), [1, 2]);
  });

  it('records effect:failed on throw and re-throws', async () => {
    const { store, runtime } = await newRuntime();
    await assert.rejects(
      () => runtime.effect('boom', async () => {
        throw new Error('upstream failure');
      }),
      /upstream failure/,
    );
    const events = await store.readEvents(RUN_ID);
    assert.equal(events[1].kind, 'effect:failed');
    const payload = events[1].payload as { message: string };
    assert.equal(payload.message, 'upstream failure');
  });
});

describe('EffectRuntime — replay', () => {
  it('returns recorded result without invoking fn', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:started', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: {} });
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:completed', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: 'cached' });

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    let invoked = false;
    const out = await runtime.effect('a', async () => {
      invoked = true;
      return 'live';
    });
    assert.equal(invoked, false);
    assert.equal(out, 'cached');
  });

  it('replays recorded failure as ReplayedEffectError', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:started', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: {} });
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:failed', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: { message: 'first crash' } });

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    await assert.rejects(
      () => runtime.effect('a', async () => 'never'),
      ReplayedEffectError,
    );
  });

  it('Phase G2: replays preserve UpstreamError retryable + status + name shape', async () => {
    // Pass 1 — record an UpstreamError live.
    const { store, runtime } = await newRuntime();
    await assert.rejects(
      () => runtime.effect('a', async () => {
        const err = new Error('upstream 503') as Error & {
          name: string; retryable: boolean; status: number;
        };
        err.name = 'UpstreamError';
        err.retryable = true;
        err.status = 503;
        throw err;
      }),
      /upstream 503/,
    );

    // Pass 2 — replay; ReplayedEffectError must carry retryable=true,
    // status=503, name='UpstreamError' so chain-fallback predicates pass.
    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const replay = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    let captured: unknown;
    try {
      await replay.effect('a', async () => 'never');
    } catch (err) {
      captured = err;
    }
    assert.ok(captured instanceof ReplayedEffectError, 'should be ReplayedEffectError');
    const err = captured as Error & { name: string; retryable?: boolean; status?: number };
    assert.equal(err.name, 'UpstreamError', 'name preserved');
    assert.equal(err.retryable, true, 'retryable flag preserved');
    assert.equal(err.status, 503, 'status preserved');
    assert.match(err.message, /upstream 503/, 'message preserved');
  });

  it('crashed mid-effect (started without completion) re-runs fn and writes completed', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:started', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: {} });

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    let invoked = false;
    const out = await runtime.effect('a', async () => {
      invoked = true;
      return 'recovered';
    });
    assert.equal(invoked, true);
    assert.equal(out, 'recovered');
    const events = await store.readEvents(RUN_ID);
    // started (existing) + completed (new). NO new started.
    assert.equal(events.filter((e) => e.kind === 'effect:started').length, 1);
    assert.equal(events.filter((e) => e.kind === 'effect:completed').length, 1);
  });

  it('past replay frontier → live execution', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:started', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: {} });
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:completed', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: 'first' });

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    const a = await runtime.effect('a', async () => 'never');
    const b = await runtime.effect('b', async () => 'second');
    assert.equal(a, 'first');
    assert.equal(b, 'second');
  });
});

describe('EffectRuntime — divergence', () => {
  it('throws DeterminismViolationError on name mismatch', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:started', stepId: STEP, effectKey: 'first', effectIdx: 0, payload: {} });
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:completed', stepId: STEP, effectKey: 'first', effectIdx: 0, payload: 'x' });

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    await assert.rejects(
      () => runtime.effect('second', async () => 'live'),
      DeterminismViolationError,
    );
  });

  it('throws DeterminismViolationError on idempotencyKey mismatch', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({
      runId: RUN_ID,
      kind: 'effect:started',
      stepId: STEP,
      effectKey: 'a',
      effectIdx: 0,
      payload: { idempotencyKey: 'k-v1' },
    });
    await store.appendEvent({ runId: RUN_ID, kind: 'effect:completed', stepId: STEP, effectKey: 'a', effectIdx: 0, payload: 'x' });

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    await assert.rejects(
      () => runtime.effect('a', async () => 'live', { idempotencyKey: 'k-v2' }),
      DeterminismViolationError,
    );
  });
});

describe('EffectRuntime — system effects', () => {
  it('now/uuid/random/sleep are recorded and replay deterministically', async () => {
    const { store, runtime } = await newRuntime();
    const liveNow = await runtime.now();
    const liveUuid = await runtime.uuid();
    const liveRandom = await runtime.random();
    await runtime.sleep(0);

    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const replay = new EffectRuntime({ store, runId: RUN_ID, stepId: STEP, recordedEffects: recorded });
    assert.equal(await replay.now(), liveNow);
    assert.equal(await replay.uuid(), liveUuid);
    assert.equal(await replay.random(), liveRandom);
    await replay.sleep(0); // doesn't throw
  });
});

describe('EffectRuntime — signals', () => {
  it('waitForSignal consumes a queued signal and records the consumption', async () => {
    const { store, runtime } = await newRuntime();
    await store.enqueueSignal(RUN_ID, 'reviewer', { decision: 'approve' });
    const signal = await runtime.waitForSignal('reviewer');
    assert.deepEqual(signal, { decision: 'approve' });
    const events = await store.readEvents(RUN_ID);
    const completed = events.find((e) => e.kind === 'effect:completed' && e.effectKey === '__signal:reviewer');
    assert.deepEqual(completed?.payload, { decision: 'approve' });
  });

  it('replays a previously-received signal without re-blocking', async () => {
    const { store } = await newRuntime();
    await store.appendEvent({
      runId: RUN_ID,
      kind: 'effect:started',
      stepId: STEP,
      effectKey: '__signal:reviewer',
      effectIdx: 0,
      payload: { channel: 'reviewer' },
    });
    await store.appendEvent({
      runId: RUN_ID,
      kind: 'effect:completed',
      stepId: STEP,
      effectKey: '__signal:reviewer',
      effectIdx: 0,
      payload: { decision: 'approve' },
    });
    const recorded = await store.readEffectEvents(RUN_ID, STEP);
    const runtime = new EffectRuntime({
      store,
      runId: RUN_ID,
      stepId: STEP,
      recordedEffects: recorded,
      realSleep: async () => {
        throw new Error('Should not block on replay');
      },
    });
    const out = await runtime.waitForSignal('reviewer');
    assert.deepEqual(out, { decision: 'approve' });
  });

  it('waitForSignal aborts when the cancellation signal fires (finding 4)', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun({ runId: RUN_ID, project: 'p', feature: 'f', featureSlug: 'f' });
    const controller = new AbortController();
    controller.abort();
    const runtime = new EffectRuntime({
      store,
      runId: RUN_ID,
      stepId: STEP,
      recordedEffects: [],
      realNow: () => NOW,
      // If the abort check didn't fire we'd block here forever; throw to
      // surface that regression instead of hanging the suite.
      realSleep: async () => {
        throw new Error('should have aborted before sleeping');
      },
      signal: controller.signal,
    });
    await assert.rejects(runtime.waitForSignal('reviewer'), /cancelled while waiting/);
  });
});
