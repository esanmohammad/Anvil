/**
 * Phase G3 — multi-process lease arbitration.
 *
 * Validates that SQLite WAL + the acquireLease transaction
 * actually serialize correctly under contention. We don't fork
 * Node processes (slow, brittle); instead two `SQLiteDurableStore`
 * instances pointing at the same db file simulate two peer
 * processes — each holds its own `better-sqlite3` connection and
 * its own internal in-memory state, but the underlying file
 * locking is the same arbitration surface a real two-process
 * setup would hit.
 *
 * Coverage:
 *   - Concurrent acquireLease calls: only one wins.
 *   - Lease renewal: only the holder can extend.
 *   - Heartbeat / takeover: holder lets ttl elapse → peer takes over.
 *   - Race with parallel takeovers via Promise.all.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteDurableStore, tryTakeOverLease } from '../durable/index.js';

const NOW_BASE = 1_700_000_000_000;

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anvil-mproc-test-'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const dbPath = (suite: string): string =>
  join(tmp, `${suite}-${Math.random().toString(36).slice(2)}.db`);

const newRun = (suffix = '1') => ({
  runId: `run-${suffix}`,
  project: 'p',
  feature: 'f',
  featureSlug: 'f',
});

describe('Multi-process lease arbitration (G3)', () => {
  it('concurrent acquireLease — only one wins', async () => {
    const path = dbPath('concurrent-acq');
    const storeA = new SQLiteDurableStore({ path });
    const storeB = new SQLiteDurableStore({ path });
    try {
      await storeA.createRun(newRun());
      // Both peers race; SQLite serializes writes via WAL + the
      // transaction in acquireLease.
      const results = await Promise.all([
        storeA.acquireLease('run-1', 'host-A', 30_000),
        storeB.acquireLease('run-1', 'host-B', 30_000),
      ]);
      const wins = results.filter(Boolean).length;
      assert.equal(wins, 1, 'exactly one peer must win');
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  it('only the lease holder can renew', async () => {
    const path = dbPath('renew');
    const storeA = new SQLiteDurableStore({ path });
    const storeB = new SQLiteDurableStore({ path });
    try {
      await storeA.createRun(newRun());
      assert.equal(await storeA.acquireLease('run-1', 'host-A', 30_000), true);
      // Peer B tries to renew without owning the lease.
      assert.equal(await storeB.renewLease('run-1', 'host-B', 30_000), false);
      // Holder A renews successfully.
      assert.equal(await storeA.renewLease('run-1', 'host-A', 30_000), true);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  it('peer takes over after the holder lets ttl elapse', async () => {
    const path = dbPath('takeover');
    let now = NOW_BASE;
    const storeA = new SQLiteDurableStore({ path, clock: () => now });
    const storeB = new SQLiteDurableStore({ path, clock: () => now });
    try {
      await storeA.createRun(newRun());
      assert.equal(await storeA.acquireLease('run-1', 'host-A', 100), true);
      // Peer B can't take it while live.
      assert.equal(await tryTakeOverLease(storeB, 'run-1', 'host-B', 100), false);
      // Time advances past A's ttl.
      now += 200;
      // Now B wins.
      assert.equal(await tryTakeOverLease(storeB, 'run-1', 'host-B', 100), true);
      // Verify the durable row reflects B's ownership.
      const r = await storeA.getRun('run-1');
      assert.equal(r?.leaseHolder, 'host-B');
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  it('parallel takeovers from many peers — exactly one wins', async () => {
    const path = dbPath('many-peers');
    let now = NOW_BASE;
    const stores = Array.from({ length: 5 }, (_, i) =>
      new SQLiteDurableStore({ path, clock: () => now }),
    );
    try {
      await stores[0].createRun(newRun());
      // Set up an expired lease.
      await stores[0].acquireLease('run-1', 'host-prev', 10);
      now += 100; // expired
      // 5 peers race for takeover concurrently.
      const wins = await Promise.all(
        stores.map((s, i) => tryTakeOverLease(s, 'run-1', `host-${i}`, 30_000)),
      );
      const winners = wins.filter(Boolean).length;
      assert.equal(winners, 1, `expected exactly 1 winner, got ${winners}`);
    } finally {
      for (const s of stores) await s.close();
    }
  });

  it('events written by peer A are visible to peer B', async () => {
    const path = dbPath('event-visibility');
    const storeA = new SQLiteDurableStore({ path });
    const storeB = new SQLiteDurableStore({ path });
    try {
      await storeA.createRun(newRun());
      await storeA.appendEvent({
        runId: 'run-1',
        kind: 'step:started',
        stepId: 's1',
        payload: { from: 'A' },
      });
      const events = await storeB.readEvents('run-1');
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'step:started');
      assert.deepEqual(events[0].payload, { from: 'A' });
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });

  it('signal enqueued by A is consumed by B (FIFO)', async () => {
    const path = dbPath('signals-mp');
    const storeA = new SQLiteDurableStore({ path });
    const storeB = new SQLiteDurableStore({ path });
    try {
      await storeA.createRun(newRun());
      await storeA.enqueueSignal('run-1', 'reviewer', { decision: 'approve' });
      // B consumes — proves the signal queue works across handles.
      const consumed = await storeB.consumeSignal('run-1', 'reviewer');
      assert.deepEqual(consumed, { decision: 'approve' });
      // A reads back: signal should now be consumed.
      const all = await storeA.readSignals('run-1', 'reviewer');
      assert.equal(all.length, 1);
      assert.equal(all[0].consumed, true);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  });
});
