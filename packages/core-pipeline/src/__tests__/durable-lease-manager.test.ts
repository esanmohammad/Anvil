/**
 * Phase D6 — multi-process scheduler primitives.
 *
 * Coverage:
 *   - LeaseManager.start() heartbeats keep the lease alive for as
 *     long as the process is up (verified by simulating advancing
 *     time + counting beat events).
 *   - On lost-ownership detection (renewLease returns false), the
 *     manager emits 'lost' and stops heartbeating.
 *   - tryTakeOverLease arbitrates two contending callers.
 *   - findOrphanedRuns returns running rows whose lease is past
 *     `expires`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import {
  LeaseManager,
  tryTakeOverLease,
  findOrphanedRuns,
} from '../durable/lease-manager.js';

describe('LeaseManager', () => {
  it('emits beat on each successful heartbeat', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryDurableStore(() => nowMs);
    await store.createRun({ runId: 'r1', project: 'p', feature: 'f', featureSlug: 'f' });
    await store.acquireLease('r1', 'host-A', 30_000);

    const ticks: Array<() => void> = [];
    const manager = new LeaseManager({
      store,
      runId: 'r1',
      holder: 'host-A',
      ttlMs: 30_000,
      intervalMs: 5_000,
      scheduler: {
        setInterval: (cb) => {
          ticks.push(cb);
          return ticks.length;
        },
        clearInterval: () => undefined,
      },
    });
    let beats = 0;
    manager.on('beat', () => {
      beats += 1;
    });
    manager.start();

    // Manually fire the scheduled callback three times.
    for (let i = 0; i < 3; i++) {
      nowMs += 5_000;
      await ticks[0]();
    }
    assert.equal(beats, 3);
    await manager.stop();
  });

  it('emits lost when renewLease returns false', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryDurableStore(() => nowMs);
    await store.createRun({ runId: 'r1', project: 'p', feature: 'f', featureSlug: 'f' });
    await store.acquireLease('r1', 'host-A', 30_000);

    // Peer steals the lease.
    nowMs += 31_000; // lapse expiry
    await store.acquireLease('r1', 'host-B', 30_000);

    const ticks: Array<() => void> = [];
    const manager = new LeaseManager({
      store,
      runId: 'r1',
      holder: 'host-A',
      ttlMs: 30_000,
      intervalMs: 5_000,
      scheduler: {
        setInterval: (cb) => {
          ticks.push(cb);
          return ticks.length;
        },
        clearInterval: () => undefined,
      },
    });
    let lost = 0;
    manager.on('lost', () => {
      lost += 1;
    });
    manager.start();
    await ticks[0]();
    assert.equal(lost, 1);
    assert.equal(manager.isAlive(), false);
  });
});

describe('tryTakeOverLease', () => {
  it('first caller wins; second caller fails while live', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryDurableStore(() => nowMs);
    await store.createRun({ runId: 'r1', project: 'p', feature: 'f', featureSlug: 'f' });
    assert.equal(await tryTakeOverLease(store, 'r1', 'host-A', 30_000), true);
    assert.equal(await tryTakeOverLease(store, 'r1', 'host-B', 30_000), false);
  });

  it('after expiry, peer wins', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryDurableStore(() => nowMs);
    await store.createRun({ runId: 'r1', project: 'p', feature: 'f', featureSlug: 'f' });
    await tryTakeOverLease(store, 'r1', 'host-A', 100);
    nowMs += 200;
    assert.equal(await tryTakeOverLease(store, 'r1', 'host-B', 100), true);
  });
});

describe('findOrphanedRuns', () => {
  it('returns running runs whose lease has expired', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryDurableStore(() => nowMs);
    await store.createRun({ runId: 'r-orphaned', project: 'p', feature: 'f', featureSlug: 'f' });
    await store.updateRunStatus('r-orphaned', 'running');
    await store.acquireLease('r-orphaned', 'dead-host', 100);

    await store.createRun({ runId: 'r-alive', project: 'p', feature: 'f', featureSlug: 'f' });
    await store.updateRunStatus('r-alive', 'running');
    await store.acquireLease('r-alive', 'live-host', 60_000);

    nowMs += 200; // both leases age
    const orphans = await findOrphanedRuns(store, () => nowMs);
    assert.deepEqual(orphans, ['r-orphaned']);
  });

  it('does not include leases that are still live', async () => {
    let nowMs = 1_700_000_000_000;
    const store = new InMemoryDurableStore(() => nowMs);
    await store.createRun({ runId: 'r1', project: 'p', feature: 'f', featureSlug: 'f' });
    await store.updateRunStatus('r1', 'running');
    await store.acquireLease('r1', 'live-host', 60_000);
    const orphans = await findOrphanedRuns(store, () => nowMs);
    assert.deepEqual(orphans, []);
  });

  it('does not include terminal runs', async () => {
    const store = new InMemoryDurableStore();
    await store.createRun({ runId: 'r1', project: 'p', feature: 'f', featureSlug: 'f' });
    await store.updateRunStatus('r1', 'completed');
    const orphans = await findOrphanedRuns(store);
    assert.deepEqual(orphans, []);
  });
});
