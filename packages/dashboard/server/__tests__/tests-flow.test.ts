/**
 * Test-spec read-only scenarios (Group 4 of WS-EXTRACTION-PLAN, partial).
 *
 *   - 4.0 get-test-specs on empty project → specs:[] response
 *   - 4.0b get-test-spec for missing slug → error response
 *   - 4.0c get-test-runs for missing spec → runs:[] response
 *
 * Mutating + lifecycle scenarios (4.1 run-test-spec, 4.2 review-test-spec,
 * mutation/polish/regen/contract/scenarios/flakiness) need (a) a seeded
 * Plan + TestSpec on disk and (b) a working FakeAgentManager scripted
 * with the per-stage event sequence. Deferred to a follow-up sub-PR
 * alongside `seedTestSpec(harness, ...)` helpers.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';

after(() => forceExitAfterTests());

test('4.0 get-test-specs on empty project returns empty array', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'get-test-specs', project: 'no-specs-demo' });
  const response = await client.waitFor('test-specs', 5000);

  assert.equal(response.type, 'test-specs');
  const payload = response.payload as { specs: unknown[] };
  assert.ok(Array.isArray(payload.specs));
  assert.equal(payload.specs.length, 0);
});

test('4.0b get-test-spec for missing slug returns error response', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'get-test-spec', project: 'demo', slug: 'never-existed' });
  const response = await client.waitFor('error', 5000);

  assert.equal(response.type, 'error');
  const payload = response.payload as { message: string };
  assert.match(payload.message, /Test spec.*not found/i);
});

test('4.0c get-test-runs for empty spec returns empty runs', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'get-test-runs', project: 'demo', slug: 'unstarted-spec' });
  const response = await client.waitFor('test-runs', 5000);

  assert.equal(response.type, 'test-runs');
  const payload = response.payload as { slug: string; runs: unknown[] };
  assert.equal(payload.slug, 'unstarted-spec');
  assert.ok(Array.isArray(payload.runs));
  assert.equal(payload.runs.length, 0);
});
