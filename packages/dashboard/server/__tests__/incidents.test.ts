/**
 * Incident + replay-queue read-only scenarios (Group 6 of WS-EXTRACTION-PLAN, partial).
 *
 *   - 6.0 list-incidents on empty project → incidents:[] response
 *   - 6.0b list-replay-queue empty → jobs:[] response
 *   - 6.0c list-bound-tests empty → bound:[] response
 *
 * Full incident lifecycle (6.1 ingest, 6.2 replay) need pre-seeded
 * webhook payloads + a working replay pipeline; deferred to follow-up
 * sub-PRs alongside a `seedIncident` harness helper.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';

after(() => forceExitAfterTests());

test('6.0 list-incidents on empty project returns empty array', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'list-incidents', project: 'no-incidents-demo' });
  const response = await client.waitFor('incidents', 5000);

  assert.equal(response.type, 'incidents');
  const payload = response.payload as { incidents: unknown[] };
  assert.ok(Array.isArray(payload.incidents));
  assert.equal(payload.incidents.length, 0);
});

test('6.0b list-replay-queue empty returns empty jobs', async (t) => {
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

test('6.0c list-bound-tests on empty project returns empty array', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'list-bound-tests', project: 'no-bound-demo' });
  const response = await client.waitFor('bound-tests', 5000);

  assert.equal(response.type, 'bound-tests');
  const payload = response.payload as { bound: unknown[] };
  assert.ok(Array.isArray(payload.bound));
  assert.equal(payload.bound.length, 0);
});
