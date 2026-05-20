/**
 * Integration test — proves the heal-on-failure fix actually works.
 *
 * Without the fix, a poisoned pool fails every subsequent fetch with the
 * same TypeError until the process restarts. With the fix:
 *   - call 1 succeeds against a live server
 *   - server dies → call 2 fails (TypeError: fetch failed)
 *   - recycleFetchPoolOnFailure() runs
 *   - server comes back → call 3 succeeds against the healed pool
 *
 * This is the test the plan in docs/FETCH-POOL-MANAGEMENT-PLAN.md §6.2
 * specifies as the canary for the entire fix.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';

import {
  getFetchPool,
  recycleFetchPoolOnFailure,
  getPoolMetrics,
  resetAllPools,
} from '../fetch-pool.js';

describe('fetch-pool integration — heal-on-failure end-to-end', () => {
  let server: http.Server | null = null;
  let port = 0;

  async function startServer(): Promise<void> {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => {
      server!.listen(port, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async function stopServer(): Promise<void> {
    if (!server) return;
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      // Force-close any sockets the pool may be holding so the close()
      // callback fires promptly.
      server!.closeAllConnections?.();
    });
    server = null;
  }

  before(async () => {
    await startServer();
  });

  beforeEach(async () => {
    await resetAllPools();
  });

  after(async () => {
    await stopServer();
    await resetAllPools();
  });

  it('healed pool succeeds after a network failure poisons the old pool', async () => {
    const url = `http://127.0.0.1:${port}/v1/messages`;

    // 1. First call succeeds against a live server.
    const r1 = await fetch(url, {
      // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
      dispatcher: getFetchPool('anthropic'),
    });
    assert.strictEqual(r1.status, 200);
    await r1.text();

    // 2. Kill the server. The pool now holds zombie sockets pointed at a
    //    dead listener — every subsequent fetch through the SAME dispatcher
    //    fails with `TypeError: fetch failed`.
    await stopServer();

    let caught: unknown = null;
    try {
      await fetch(url, {
        // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
        dispatcher: getFetchPool('anthropic'),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, 'expected fetch to throw with server down');
    assert.match(
      (caught as Error).message + ' ' + ((caught as Error).cause instanceof Error ? (caught as Error & { cause: Error }).cause.message : ''),
      /fetch failed|ECONNREFUSED|ECONNRESET|socket/i,
    );

    // 3. Recycle the pool — this is what the adapter's catch block does
    //    in production.
    await recycleFetchPoolOnFailure('anthropic', caught);
    const metrics = getPoolMetrics().find((m) => m.provider === 'anthropic');
    assert.strictEqual(metrics?.recycleCount, 1, 'pool should have been recycled');

    // 4. Bring the server back on the same port.
    await startServer();

    // 5. The next fetch must succeed. Without the recycle, the same zombie
    //    socket would be re-used and this would fail again.
    const r3 = await fetch(url, {
      // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
      dispatcher: getFetchPool('anthropic'),
    });
    assert.strictEqual(r3.status, 200, 'healed pool must serve the next request');
    const body = (await r3.json()) as { ok: boolean };
    assert.strictEqual(body.ok, true);
  });

  it('one provider failing does not recycle a sibling provider', async () => {
    // Touch both pools so they exist.
    getFetchPool('anthropic');
    getFetchPool('gemini');

    // Poison only one.
    await recycleFetchPoolOnFailure('anthropic', new TypeError('fetch failed'));

    const metrics = getPoolMetrics();
    const anthropic = metrics.find((m) => m.provider === 'anthropic');
    const gemini = metrics.find((m) => m.provider === 'gemini');
    assert.strictEqual(anthropic?.recycleCount, 1);
    assert.strictEqual(gemini?.recycleCount, 0, 'sibling provider must be untouched');
  });
});
