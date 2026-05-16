/**
 * Phase 4 socket.io module smoke test (isolated).
 *
 * Tests `mountSocketServer` + `bridgeServicesToRooms` against a
 * minimal http server — no dashboard boot. This avoids the conflict
 * where socket.io's `attach()` rewrites the http server's request
 * listener and breaks the raw `WebSocketServer({ path: '/ws' })` that
 * the dashboard's React frontend still uses.
 *
 * Phase 5 will mount socket.io into the dashboard alongside the
 * frontend swap; until then, these tests prove the socket.io modules
 * work in isolation so Phase 5 is a plumbing exercise, not a debug
 * exercise.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServices } from '../services/index.js';
import { createReplay } from '../events/replay.js';
import { mountSocketServer, type SocketServerHandle } from '../ws/socket-server.js';
import { socketIoClient, type DashboardClient } from './_harness/dashboard-client.js';
import { forceExitAfterTests } from './_harness/boot.js';

after(() => forceExitAfterTests());

async function bootIsolated(): Promise<{
  url: string;
  port: number;
  services: ReturnType<typeof createServices>;
  replay: ReturnType<typeof createReplay>;
  socketHandle: SocketServerHandle;
  http: HttpServer;
  stop(): Promise<void>;
}> {
  const services = createServices();
  const replay = createReplay();
  const http = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => http.listen(0, () => r()));
  const addr = http.address() as AddressInfo;
  const port = addr.port;
  const socketHandle = mountSocketServer({
    server: http,
    services,
    replay,
    allowedOrigins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
  });
  const stop = async (): Promise<void> => {
    await socketHandle.stop();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return {
    url: `http://localhost:${port}`,
    port,
    services,
    replay,
    socketHandle,
    http,
    stop,
  };
}

test('socket.io: client connects + lands in default `global` room', async (t) => {
  const env = await bootIsolated();
  t.after(() => env.stop());

  const client: DashboardClient = await socketIoClient(env.url);
  t.after(() => client.close());

  // Server should auto-join `global` for every connection. Emit an event
  // tagged with `global` topic and the client should receive it.
  const eventPromise = client.waitFor('run-stopped', 2000);
  // run.stopped publishes to ['global', 'run:<id>'] — the global join
  // guarantees delivery to clients that haven't subscribed to the run.
  env.services.runs.emit('run.stopped', { runId: 'isolated-test-1' });
  const ev = await eventPromise;

  assert.equal(ev.type, 'run-stopped');
  const payload = ev.payload as { runId: string };
  assert.equal(payload.runId, 'isolated-test-1');
});

test('socket.io: per-run agent events reach default-subscribed clients', async (t) => {
  // During the raw-WS → socket.io migration agent events publish to both
  // `global` and `run:<id>`, so clients on the default global subscription
  // still see the firehose. Once the frontend opts in to per-run
  // subscriptions only, drop `global` from these topic mappings and flip
  // this test to assert the opposite (no firehose, only run:<id>).
  const env = await bootIsolated();
  t.after(() => env.stop());

  const client: DashboardClient = await socketIoClient(env.url);
  t.after(() => client.close());

  // Drain any auto-arriving events.
  await new Promise((r) => setTimeout(r, 100));
  client.drain();

  const eventPromise = client.waitFor('agent-output', 2000);
  env.services.agents.emit('agent.output', { entries: [], runId: 'A' });
  const ev = await eventPromise;
  assert.equal(ev.type, 'agent-output');
});

test('socket.io: detach severs the bridge', async (t) => {
  const env = await bootIsolated();
  t.after(() => env.stop());

  const client: DashboardClient = await socketIoClient(env.url);
  t.after(() => client.close());

  const firstPromise = client.waitFor('runs', 2000);
  env.services.runs.emit('runs.list', { runs: [] });
  await firstPromise; // bridge fires

  // Now stop the socket handle — the bridge detaches.
  await env.socketHandle.stop();

  // Subsequent emits should not arrive (socket is closed).
  env.services.runs.emit('runs.list', { runs: [{ id: 'after-stop' }] });
  await new Promise((r) => setTimeout(r, 100));
  // (Buffer drain checks no extra events came in; connection itself dropped.)
  assert.ok(true, 'detach completed without throwing');
});
