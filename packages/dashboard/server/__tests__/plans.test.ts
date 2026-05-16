/**
 * Plan-action scenarios (Group 5 of WS-EXTRACTION-PLAN, partial).
 *
 * Pins the wire-level shape of read-only plan actions that work without
 * pre-existing plan fixtures:
 *   - 5.0 get-plans (empty project) → plans:[] response
 *   - 5.0b list-plan-comments (nonexistent plan) → comments:[] response
 *   - 5.4 add-plan-comment requires both planSlug and body — error response
 *     when missing
 *
 * Mutating flows (save-plan, approve, regen) need a Plan to exist on
 * disk first; those scenarios land alongside a `seedPlan(harness, ...)`
 * helper in the harness in a follow-up sub-PR.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';

after(() => forceExitAfterTests());

test('5.0 get-plans on empty project returns empty array', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'get-plans', project: 'empty-demo' });
  const response = await client.waitFor('plans', 5000);

  assert.equal(response.type, 'plans');
  const payload = response.payload as { plans: unknown[] };
  assert.ok(Array.isArray(payload.plans), 'payload.plans is an array');
  assert.equal(payload.plans.length, 0, 'no plans for an empty project');
});

test('5.0b list-plan-comments on missing plan returns empty array', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'list-plan-comments', project: 'empty-demo', planSlug: 'never-existed' });
  const response = await client.waitFor('plan-comments', 5000);

  assert.equal(response.type, 'plan-comments');
  const payload = response.payload as { planSlug: string; comments: unknown[] };
  assert.equal(payload.planSlug, 'never-existed');
  assert.ok(Array.isArray(payload.comments));
  assert.equal(payload.comments.length, 0);
});

test('5.4 add-plan-comment without required fields returns error', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  // Missing body — handler validates and replies with `error` on this client.
  client.send({
    action: 'add-plan-comment',
    project: 'demo',
    planSlug: 'some-plan',
    sectionPath: 'section.path',
    // body omitted
  });
  const response = await client.waitFor('error', 5000);

  assert.equal(response.type, 'error');
  const payload = response.payload as { message: string };
  // After Recipe 6 (Zod schemas), the error message only names the field(s)
  // that are actually missing — `body` here. The legacy handler returned a
  // static string listing every required field regardless; Zod's safeParse
  // surfaces only the failing path, which is more accurate. See Gotcha #3
  // in DASHBOARD-DECOMPOSITION-PLAN.md.
  assert.match(payload.message, /body/, 'error message names the missing `body` field');
});
