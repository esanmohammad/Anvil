/**
 * Canary test for the dashboard harness.
 *
 * Boots a dashboard server on an ephemeral port, connects a WS client,
 * waits for the `init` message, snapshots the normalized payload shape.
 *
 * This is the smallest "harness is wired up" test — Phase 0.5 acceptance
 * gate. Real scenarios (Phase 1) layer on top of this.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';
import { stripVolatile } from './_harness/strip-volatile.js';
import { matchSnapshot } from './_harness/snapshot-store.js';

after(() => forceExitAfterTests());

test('canary: boot → connect → init', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());

  const init = await client.waitFor('init', 5000);
  assert.equal(init.type, 'init');
  assert.ok(typeof init.payload === 'object' && init.payload !== null, 'init.payload is object');

  // Normalize timestamps / ids / ports / tmp paths before snapshotting.
  const normalized = stripVolatile(init);

  // Strip noisy fields that aren't part of the canary contract — projects
  // and availableModels depend on the user's env at test time. We pin the
  // structural keys, not their dynamic contents.
  const shape = {
    type: (normalized as { type: string }).type,
    payloadKeys: Object.keys((normalized as { payload: Record<string, unknown> }).payload).sort(),
  };
  matchSnapshot(shape, { name: 'canary-init' });
});
