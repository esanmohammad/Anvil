/**
 * Phase 7 end-to-end socket.io action routing.
 *
 * Verifies that the dashboard's socket.io mount routes inbound client
 * actions through `handleClientMessage` (via the fauxWs adapter) and
 * emits replies back as `{type, payload}` frames. This is the contract
 * the frontend hook (`useDashboardSocket`) and the WS-compat proxy
 * (`ws-compat-proxy.ts`) rely on to drive existing ~150 action handlers
 * unchanged.
 *
 * The previous `socket-io-smoke.test.ts` covered isolated module wiring
 * (mountSocketServer + bridge). These scenarios cover dashboard boot +
 * onAction routing end-to-end so Recipe 2 (deleting raw WS) can land
 * with confidence.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';

after(() => forceExitAfterTests());

test('socket.io: list-incidents on empty project routes through handleClientMessage', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());

  // Default subscription joins `global`. `init` ships on connect via
  // mountSocketServer's sendInit hook — wait for it as proof the boot
  // path is alive on socket.io.
  await client.waitFor('init', 5000);

  client.send({ action: 'list-incidents', project: 'no-incidents-demo' });
  const response = await client.waitFor('incidents', 5000);

  assert.equal(response.type, 'incidents');
  const payload = response.payload as { incidents: unknown[] };
  assert.ok(Array.isArray(payload.incidents));
  assert.equal(payload.incidents.length, 0);
});

test('socket.io: get-plans on empty project routes through handleClientMessage', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'get-plans', project: 'no-plans-demo' });
  const response = await client.waitFor('plans', 5000);

  assert.equal(response.type, 'plans');
  const payload = response.payload as { plans: unknown[] };
  assert.ok(Array.isArray(payload.plans));
  assert.equal(payload.plans.length, 0);
});

test('socket.io: list-replay-queue returns empty jobs', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'list-replay-queue' });
  const response = await client.waitFor('replay-queue', 5000);

  assert.equal(response.type, 'replay-queue');
  const payload = response.payload as { jobs: unknown[] };
  assert.ok(Array.isArray(payload.jobs));
  assert.equal(payload.jobs.length, 0);
});
