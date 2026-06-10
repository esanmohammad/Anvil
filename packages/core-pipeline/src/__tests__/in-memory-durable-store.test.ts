/**
 * Phase D1 — `InMemoryDurableStore` driver.
 *
 * Covers run lifecycle, cursor + status updates, append-only event
 * semantics, lease arbitration, signal queueing, and vacuum.
 *
 * The contract is bit-identical to `SQLiteDurableStore` — fixtures
 * here are mirrored in `sqlite-durable-store.test.ts` so a regression
 * in one driver shows up immediately in the other suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';

const NOW = 1_700_000_000_000;

const newRun = (suffix = '1') => ({
  runId: `run-${suffix}`,
  project: 'p',
  feature: 'f',
  featureSlug: 'f',
});

describe('InMemoryDurableStore — run lifecycle', () => {
  it('creates a fresh run with status pending and cursorSeq 0', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    const run = await store.createRun(newRun());
    assert.equal(run.status, 'pending');
    assert.equal(run.cursorSeq, 0);
    assert.equal(run.workflowVer, 1);
    assert.ok(run.startedAt);
    assert.equal(run.leaseHolder, null);
  });

  it('createRun is idempotent — same runId returns existing record', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    const a = await store.createRun(newRun());
    const b = await store.createRun(newRun());
    assert.equal(a.startedAt, b.startedAt);
  });

  it('updateRunStatus reflects status + currentStep', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.updateRunStatus('run-1', 'running', 'requirements');
    const r = await store.getRun('run-1');
    assert.equal(r?.status, 'running');
    assert.equal(r?.currentStep, 'requirements');
  });

  it('updateRunCursor advances cursorSeq', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.updateRunCursor('run-1', 12);
    const r = await store.getRun('run-1');
    assert.equal(r?.cursorSeq, 12);
  });

  it('listRunsByStatus filters correctly', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun('1'));
    await store.createRun(newRun('2'));
    await store.updateRunStatus('run-1', 'running');
    const running = await store.listRunsByStatus('running');
    assert.equal(running.length, 1);
    assert.equal(running[0].runId, 'run-1');
  });
});

describe('InMemoryDurableStore — events', () => {
  it('appendEvent assigns monotonically increasing seq', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    const a = await store.appendEvent({ runId: 'run-1', kind: 'step:started', stepId: 's1', payload: {} });
    const b = await store.appendEvent({ runId: 'run-1', kind: 'step:completed', stepId: 's1', payload: {} });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
  });

  it('appendBatch is atomic — all rows share the same monotonic block', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    const out = await store.appendBatch([
      { runId: 'run-1', kind: 'step:started', stepId: 's1', payload: { i: 0 } },
      { runId: 'run-1', kind: 'effect:started', stepId: 's1', effectKey: 'e', effectIdx: 0, payload: {} },
      { runId: 'run-1', kind: 'effect:completed', stepId: 's1', effectKey: 'e', effectIdx: 0, payload: { ok: true } },
    ]);
    assert.deepEqual(out.map((e) => e.seq), [1, 2, 3]);
  });

  it('readEvents fromSeq returns the tail', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.appendEvent({ runId: 'run-1', kind: 'step:started', stepId: 's1', payload: {} });
    await store.appendEvent({ runId: 'run-1', kind: 'step:completed', stepId: 's1', payload: {} });
    await store.appendEvent({ runId: 'run-1', kind: 'step:started', stepId: 's2', payload: {} });
    const tail = await store.readEvents('run-1', 3);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].stepId, 's2');
  });

  it('readEffectEvents pairs started+completed by (key, idx)', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.appendEvent({ runId: 'run-1', kind: 'effect:started', stepId: 's1', effectKey: 'a', effectIdx: 0, payload: {} });
    await store.appendEvent({ runId: 'run-1', kind: 'effect:completed', stepId: 's1', effectKey: 'a', effectIdx: 0, payload: { v: 1 } });
    await store.appendEvent({ runId: 'run-1', kind: 'effect:started', stepId: 's1', effectKey: 'a', effectIdx: 1, payload: {} });
    const pairs = await store.readEffectEvents('run-1', 's1');
    assert.equal(pairs.length, 2);
    assert.deepEqual(pairs[0].completed?.payload, { v: 1 });
    assert.equal(pairs[1].completed, undefined);
  });
});

describe('InMemoryDurableStore — lease', () => {
  it('first acquireLease succeeds; second call from a different holder fails while live', async () => {
    let now = NOW;
    const store = new InMemoryDurableStore(() => now);
    await store.createRun(newRun());
    assert.equal(await store.acquireLease('run-1', 'host-A', 1000), true);
    assert.equal(await store.acquireLease('run-1', 'host-B', 1000), false);
  });

  it('after lease expires, a peer can take over', async () => {
    let now = NOW;
    const store = new InMemoryDurableStore(() => now);
    await store.createRun(newRun());
    await store.acquireLease('run-1', 'host-A', 100);
    now += 200;
    assert.equal(await store.acquireLease('run-1', 'host-B', 100), true);
  });

  it('renewLease only succeeds for the current holder', async () => {
    let now = NOW;
    const store = new InMemoryDurableStore(() => now);
    await store.createRun(newRun());
    await store.acquireLease('run-1', 'host-A', 1000);
    assert.equal(await store.renewLease('run-1', 'host-A', 1000), true);
    assert.equal(await store.renewLease('run-1', 'host-B', 1000), false);
  });

  it('releaseLease drops ownership', async () => {
    let now = NOW;
    const store = new InMemoryDurableStore(() => now);
    await store.createRun(newRun());
    await store.acquireLease('run-1', 'host-A', 1000);
    await store.releaseLease('run-1', 'host-A');
    const r = await store.getRun('run-1');
    assert.equal(r?.leaseHolder, null);
  });
});

describe('InMemoryDurableStore — signals', () => {
  it('FIFO consumption per channel', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.enqueueSignal('run-1', 'reviewer', { v: 1 });
    await store.enqueueSignal('run-1', 'reviewer', { v: 2 });
    assert.deepEqual(await store.consumeSignal('run-1', 'reviewer'), { v: 1 });
    assert.deepEqual(await store.consumeSignal('run-1', 'reviewer'), { v: 2 });
    assert.equal(await store.consumeSignal('run-1', 'reviewer'), null);
  });

  it('different channels are independent', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.enqueueSignal('run-1', 'a', { v: 'a' });
    await store.enqueueSignal('run-1', 'b', { v: 'b' });
    assert.deepEqual(await store.consumeSignal('run-1', 'b'), { v: 'b' });
    assert.deepEqual(await store.consumeSignal('run-1', 'a'), { v: 'a' });
  });

  it('consumeSignalAndRecord pops the signal AND writes an effect:completed atomically (finding 5)', async () => {
    const store = new InMemoryDurableStore(() => NOW);
    await store.createRun(newRun());
    await store.enqueueSignal('run-1', 'stage:answer', 'the answer');
    const payload = await store.consumeSignalAndRecord('run-1', 'stage:answer', {
      stepId: 'validate',
      effectKey: '__signal:stage:answer',
      effectIdx: 3,
    });
    assert.equal(payload, 'the answer');
    const events = await store.readEvents('run-1');
    const completed = events.find(
      (e) => e.kind === 'effect:completed' && e.effectKey === '__signal:stage:answer',
    );
    assert.ok(completed, 'effect:completed receipt must be written in the same call');
    assert.equal(completed?.effectIdx, 3);
    assert.equal(completed?.payload, 'the answer');
    // Consumed — a second call finds nothing and records nothing.
    const again = await store.consumeSignalAndRecord('run-1', 'stage:answer', {
      stepId: 'validate',
      effectKey: '__signal:stage:answer',
      effectIdx: 4,
    });
    assert.equal(again, null);
  });
});

describe('InMemoryDurableStore — vacuum', () => {
  it('only deletes terminal runs older than the cutoff', async () => {
    let now = NOW;
    const store = new InMemoryDurableStore(() => now);
    await store.createRun(newRun('old'));
    await store.updateRunStatus('run-old', 'completed');
    now += 1000;
    await store.createRun(newRun('new'));
    await store.updateRunStatus('run-new', 'completed');
    const stats = await store.vacuum(new Date(NOW + 500).toISOString());
    assert.equal(stats.runs, 1);
    assert.equal((await store.getRun('run-old'))?.runId, undefined);
    assert.equal((await store.getRun('run-new'))?.runId, 'run-new');
  });

  it('does not delete in-flight runs even when they are older', async () => {
    let now = NOW;
    const store = new InMemoryDurableStore(() => now);
    await store.createRun(newRun('running'));
    await store.updateRunStatus('run-running', 'running');
    now += 1000;
    const stats = await store.vacuum(new Date(NOW + 500).toISOString());
    assert.equal(stats.runs, 0);
    assert.equal((await store.getRun('run-running'))?.status, 'running');
  });
});
