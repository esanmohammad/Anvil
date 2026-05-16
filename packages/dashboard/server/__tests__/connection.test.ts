/**
 * Connection-lifecycle scenarios (Group 7 of WS-EXTRACTION-PLAN).
 *
 * Pins the wire-level behavior of:
 *   - 7.2 Origin check rejects unauthorized origins
 *   - 7.3 Reconnect → `get-state` re-replays `init`
 *
 * Groups 7.4 (subscribe-backfill) and 7.5 (unsubscribe) ship in Phase 4
 * when socket.io rooms land — those scenarios are no-ops against today's
 * raw-WS server.
 *
 * Shared boot across this file: connection-only scenarios don't mutate
 * server state, so we pay the ~10 s boot cost once instead of N times.
 */

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';

import { io as socketIoConnect } from 'socket.io-client';

import { bootDashboard, forceExitAfterTests, type DashboardHarness } from './_harness/boot.js';
import { stripVolatile } from './_harness/strip-volatile.js';
import { matchSnapshot } from './_harness/snapshot-store.js';

let harness: DashboardHarness;

before(async () => {
  harness = await bootDashboard();
});

after(async () => {
  await harness.stop();
  forceExitAfterTests();
});

test('7.2 unauthorized origin is rejected by socket.io CORS', async () => {
  // socket.io's allowedOrigins callback rejects unknown Origins with a
  // connect error. We bypass the harness client (which sets a legit
  // Origin by default) and connect directly with a forged Origin.
  const httpUrl = `http://localhost:${harness.port}`;
  const errPromise = new Promise<Error>((resolve) => {
    const sock = socketIoConnect(httpUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { Origin: 'http://evil.example.com' },
    });
    sock.on('connect_error', (err) => resolve(err as Error));
    sock.on('connect', () => {
      sock.disconnect();
      resolve(new Error('unexpected: connect succeeded'));
    });
  });
  const err = await errPromise;
  // socket.io surfaces the CORS reject as a generic engine.io websocket
  // error (the server closes the upgrade with the CORS error message
  // baked in, but engine.io-client only exposes the transport-level
  // failure to the caller). Asserting the connection did NOT succeed is
  // enough to lock in the reject path; the actual CORS rule is unit-
  // tested via `mountSocketServer`'s allowedOrigins callback.
  assert.ok(
    !/unexpected: connect succeeded/.test(err.message),
    `expected reject but got: ${err.message}`,
  );
});

test('7.3 reconnect resends init on get-state', async () => {
  // First connection — capture init.
  const c1 = await harness.connectClient();
  const init1 = await c1.waitFor('init', 5000);
  await c1.close();

  // Reconnect, send get-state, expect a second init with the same shape.
  const c2 = await harness.connectClient();
  // sendInit fires automatically on connection, before any client message.
  const initOnConnect = await c2.waitFor('init', 5000);

  // Then a get-state should re-send the same init shape.
  c2.send({ action: 'get-state' });
  // Drain init events; we want the next one (the response to get-state).
  // sendInit doesn't emit a follow-up event type, it just re-emits 'init'.
  const initOnGetState = await c2.waitFor('init', 5000);

  await c2.close();

  // Normalize each payload and verify the SHAPES match across emissions.
  const shape = (msg: { payload: unknown }): string[] =>
    Object.keys((msg.payload ?? {}) as Record<string, unknown>).sort();

  assert.deepEqual(shape(init1), shape(initOnConnect), 'reconnect init keys match first init');
  assert.deepEqual(shape(initOnConnect), shape(initOnGetState), 'get-state init keys match connect init');

  // Pin the shape of the reconnect init (volatile fields stripped).
  const normalized = stripVolatile(initOnGetState);
  matchSnapshot(
    {
      type: (normalized as { type: string }).type,
      payloadKeys: shape(initOnGetState),
    },
    { name: 'connection-7.3-reconnect-init' },
  );
});
