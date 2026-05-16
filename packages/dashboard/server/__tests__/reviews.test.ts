/**
 * Review read-only scenarios (Group 3 of WS-EXTRACTION-PLAN, partial).
 *
 *   - 3.0 list-reviews empty project → reviews:[] response
 *   - 3.0b get-review missing → error response
 *
 * Full review lifecycle (3.1 run-review-pr, 3.3 resolve, 3.4 apply-fix)
 * needs a seeded PR + reviewer chain; deferred to follow-up alongside
 * `seedReview(harness, ...)` helpers.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';

after(() => forceExitAfterTests());

test('3.0 list-reviews on empty project returns empty array', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'list-reviews', project: 'no-reviews-demo' });
  const response = await client.waitFor('reviews', 5000);

  assert.equal(response.type, 'reviews');
  const payload = response.payload as { reviews: unknown[] };
  assert.ok(Array.isArray(payload.reviews));
  assert.equal(payload.reviews.length, 0);
});

test('3.0b get-review for missing reviewId returns review:null', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'get-review', project: 'demo', reviewId: 'never-existed-id' });
  const response = await client.waitFor('review', 5000);

  assert.equal(response.type, 'review');
  const payload = response.payload as { review: unknown };
  assert.equal(payload.review, null, 'missing review returns null');
});
