/**
 * Phase D1 — `SQLiteDurableStore` driver.
 *
 * Mirror image of the in-memory driver suite. Each test creates a
 * fresh DB file in `os.tmpdir()` so suites don't share state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteDurableStore } from '../durable/sqlite-store.js';

const NOW = 1_700_000_000_000;

const newRun = (suffix = '1') => ({
  runId: `run-${suffix}`,
  project: 'p',
  feature: 'f',
  featureSlug: 'f',
});

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anvil-sqlite-test-'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const path = (suite: string) => join(tmp, `${suite}-${Math.random().toString(36).slice(2)}.db`);

describe('SQLiteDurableStore — run lifecycle', () => {
  it('creates a fresh run with status pending and cursorSeq 0', async () => {
    const store = new SQLiteDurableStore({ path: path('lifecycle'), clock: () => NOW });
    const run = await store.createRun(newRun());
    assert.equal(run.status, 'pending');
    assert.equal(run.cursorSeq, 0);
    assert.equal(run.workflowVer, 1);
    await store.close();
  });

  it('createRun is idempotent', async () => {
    const store = new SQLiteDurableStore({ path: path('idempotent'), clock: () => NOW });
    const a = await store.createRun(newRun());
    const b = await store.createRun(newRun());
    assert.equal(a.startedAt, b.startedAt);
    await store.close();
  });

  it('updateRunStatus + updateRunCursor persist', async () => {
    const store = new SQLiteDurableStore({ path: path('status'), clock: () => NOW });
    await store.createRun(newRun());
    await store.updateRunStatus('run-1', 'running', 'requirements');
    await store.updateRunCursor('run-1', 7);
    const r = await store.getRun('run-1');
    assert.equal(r?.status, 'running');
    assert.equal(r?.currentStep, 'requirements');
    assert.equal(r?.cursorSeq, 7);
    await store.close();
  });

  it('listRunsByStatus filters', async () => {
    const store = new SQLiteDurableStore({ path: path('list'), clock: () => NOW });
    await store.createRun(newRun('1'));
    await store.createRun(newRun('2'));
    await store.updateRunStatus('run-1', 'running');
    const running = await store.listRunsByStatus('running');
    assert.equal(running.length, 1);
    await store.close();
  });
});

describe('SQLiteDurableStore — events', () => {
  it('appendEvent assigns monotonic seq', async () => {
    const store = new SQLiteDurableStore({ path: path('events-seq'), clock: () => NOW });
    await store.createRun(newRun());
    const a = await store.appendEvent({ runId: 'run-1', kind: 'step:started', payload: {} });
    const b = await store.appendEvent({ runId: 'run-1', kind: 'step:completed', payload: {} });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    await store.close();
  });

  it('appendBatch is atomic', async () => {
    const store = new SQLiteDurableStore({ path: path('events-batch'), clock: () => NOW });
    await store.createRun(newRun());
    const out = await store.appendBatch([
      { runId: 'run-1', kind: 'step:started', stepId: 's1', payload: {} },
      { runId: 'run-1', kind: 'effect:started', stepId: 's1', effectKey: 'e', effectIdx: 0, payload: {} },
      { runId: 'run-1', kind: 'effect:completed', stepId: 's1', effectKey: 'e', effectIdx: 0, payload: { v: 1 } },
    ]);
    assert.deepEqual(out.map((e) => e.seq), [1, 2, 3]);
    await store.close();
  });

  it('readEvents fromSeq returns the tail', async () => {
    const store = new SQLiteDurableStore({ path: path('events-tail'), clock: () => NOW });
    await store.createRun(newRun());
    await store.appendEvent({ runId: 'run-1', kind: 'step:started', stepId: 's1', payload: {} });
    await store.appendEvent({ runId: 'run-1', kind: 'step:completed', stepId: 's1', payload: {} });
    await store.appendEvent({ runId: 'run-1', kind: 'step:started', stepId: 's2', payload: {} });
    const tail = await store.readEvents('run-1', 3);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].stepId, 's2');
    await store.close();
  });

  it('readEffectEvents pairs started+completed', async () => {
    const store = new SQLiteDurableStore({ path: path('effect-pairs'), clock: () => NOW });
    await store.createRun(newRun());
    await store.appendEvent({ runId: 'run-1', kind: 'effect:started', stepId: 's', effectKey: 'a', effectIdx: 0, payload: {} });
    await store.appendEvent({ runId: 'run-1', kind: 'effect:completed', stepId: 's', effectKey: 'a', effectIdx: 0, payload: { v: 1 } });
    await store.appendEvent({ runId: 'run-1', kind: 'effect:started', stepId: 's', effectKey: 'a', effectIdx: 1, payload: {} });
    const pairs = await store.readEffectEvents('run-1', 's');
    assert.equal(pairs.length, 2);
    assert.deepEqual(pairs[0].completed?.payload, { v: 1 });
    assert.equal(pairs[1].completed, undefined);
    await store.close();
  });

  it('payloads round-trip JSON faithfully', async () => {
    const store = new SQLiteDurableStore({ path: path('json-rt'), clock: () => NOW });
    await store.createRun(newRun());
    const payload = { a: 1, b: ['x', null, true], c: { nested: 'ok' } };
    await store.appendEvent({ runId: 'run-1', kind: 'step:completed', stepId: 's', payload });
    const evs = await store.readEvents('run-1');
    assert.deepEqual(evs[0].payload, payload);
    await store.close();
  });
});

describe('SQLiteDurableStore — lease', () => {
  it('arbitrates a single live holder', async () => {
    let now = NOW;
    const store = new SQLiteDurableStore({ path: path('lease-arb'), clock: () => now });
    await store.createRun(newRun());
    assert.equal(await store.acquireLease('run-1', 'host-A', 1000), true);
    assert.equal(await store.acquireLease('run-1', 'host-B', 1000), false);
    await store.close();
  });

  it('lets a peer take over after expiry', async () => {
    let now = NOW;
    const store = new SQLiteDurableStore({ path: path('lease-take'), clock: () => now });
    await store.createRun(newRun());
    await store.acquireLease('run-1', 'host-A', 100);
    now += 200;
    assert.equal(await store.acquireLease('run-1', 'host-B', 100), true);
    await store.close();
  });

  it('renewLease guards on holder', async () => {
    let now = NOW;
    const store = new SQLiteDurableStore({ path: path('lease-renew'), clock: () => now });
    await store.createRun(newRun());
    await store.acquireLease('run-1', 'host-A', 1000);
    assert.equal(await store.renewLease('run-1', 'host-A', 1000), true);
    assert.equal(await store.renewLease('run-1', 'host-B', 1000), false);
    await store.close();
  });
});

describe('SQLiteDurableStore — signals', () => {
  it('FIFO consumption per channel', async () => {
    const store = new SQLiteDurableStore({ path: path('signals-fifo'), clock: () => NOW });
    await store.createRun(newRun());
    await store.enqueueSignal('run-1', 'reviewer', { v: 1 });
    await store.enqueueSignal('run-1', 'reviewer', { v: 2 });
    assert.deepEqual(await store.consumeSignal('run-1', 'reviewer'), { v: 1 });
    assert.deepEqual(await store.consumeSignal('run-1', 'reviewer'), { v: 2 });
    assert.equal(await store.consumeSignal('run-1', 'reviewer'), null);
    await store.close();
  });

  it('readSignals reflects consumed flag', async () => {
    const store = new SQLiteDurableStore({ path: path('signals-flag'), clock: () => NOW });
    await store.createRun(newRun());
    await store.enqueueSignal('run-1', 'r', { v: 1 });
    await store.consumeSignal('run-1', 'r');
    const all = await store.readSignals('run-1');
    assert.equal(all.length, 1);
    assert.equal(all[0].consumed, true);
    await store.close();
  });
});

describe('SQLiteDurableStore — vacuum', () => {
  it('drops terminal runs older than cutoff (FK cascade clears events + signals)', async () => {
    let now = NOW;
    const store = new SQLiteDurableStore({ path: path('vacuum'), clock: () => now });
    await store.createRun(newRun('old'));
    await store.appendEvent({ runId: 'run-old', kind: 'step:completed', payload: {} });
    await store.enqueueSignal('run-old', 'r', { v: 1 });
    await store.updateRunStatus('run-old', 'completed');

    now += 1000;
    await store.createRun(newRun('new'));
    await store.updateRunStatus('run-new', 'completed');

    const stats = await store.vacuum(new Date(NOW + 500).toISOString());
    assert.equal(stats.runs, 1);
    assert.equal(stats.events, 1);
    assert.equal(stats.signals, 1);
    assert.equal(await store.getRun('run-old'), null);
    assert.equal((await store.getRun('run-new'))?.runId, 'run-new');
    await store.close();
  });
});
