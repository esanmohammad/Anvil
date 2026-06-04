/**
 * FO1-1a — auto-resume queue reuses the orphan's ORIGINAL runId.
 *
 * `dispatchTakenOverRuns` claims orphaned-lease runs and replays them
 * via `startPipeline`. Before Fix A's finding-7 fix it dropped the
 * runId and let `startPipeline` mint a fresh `build-<ts>` id, so the
 * durable log we'd just read back was never replayed. These tests pin
 * the contract that the orphan's own runId rides through as
 * `options.resumeRunId`.
 *
 * Pure in-process — InMemoryDurableStore + a capturing fake
 * startPipeline. No boot, no WS, no real LLM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryDurableStore } from '@esankhan3/anvil-core-pipeline';

import { dispatchTakenOverRuns } from '../durable-resume-queue.js';

const STAGES_BY_NAME: Record<string, number> = {
  clarify: 0,
  requirements: 1,
  specs: 2,
  build: 3,
  validate: 4,
  ship: 5,
};

interface Captured {
  project: string;
  feature: string;
  options?: { resumeFromStage?: number; featureSlug?: string; resumeRunId?: string };
}

async function seedOrphan(
  store: InMemoryDurableStore,
  runId: string,
  events: Array<{ kind: 'step:started' | 'step:completed' | 'step:failed'; stepId: string }>,
) {
  await store.createRun({ runId, project: 'acme', feature: 'add login', featureSlug: 'add-login' });
  for (const e of events) {
    await store.appendEvent({ runId, kind: e.kind, stepId: e.stepId, payload: {} });
  }
}

test('dispatchTakenOverRuns: reuses the orphan runId as resumeRunId', async () => {
  const store = new InMemoryDurableStore();
  const runId = 'build-orphan-abc';
  await seedOrphan(store, runId, [
    { kind: 'step:started', stepId: 'clarify' },
    { kind: 'step:completed', stepId: 'clarify' },
    { kind: 'step:started', stepId: 'requirements' }, // in-flight → resume here
  ]);

  const captured: Captured[] = [];
  const stats = await dispatchTakenOverRuns(
    store,
    [runId],
    (project, feature, options) => {
      captured.push({ project, feature, options });
    },
    STAGES_BY_NAME,
    { disabled: false, delayBetweenMs: 0 },
  );

  assert.equal(stats.dispatched, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].options?.resumeRunId, runId, 'original runId must be reused');
  assert.equal(captured[0].options?.featureSlug, 'add-login');
  // sanity: resume stage is the in-flight requirements step
  assert.equal(captured[0].options?.resumeFromStage, STAGES_BY_NAME.requirements);
});

test('dispatchTakenOverRuns: each orphan reuses its own distinct runId', async () => {
  const store = new InMemoryDurableStore();
  await seedOrphan(store, 'build-r1', [{ kind: 'step:started', stepId: 'clarify' }]);
  await seedOrphan(store, 'build-r2', [{ kind: 'step:started', stepId: 'specs' }]);

  const captured: Captured[] = [];
  await dispatchTakenOverRuns(
    store,
    ['build-r1', 'build-r2'],
    (project, feature, options) => void captured.push({ project, feature, options }),
    STAGES_BY_NAME,
    { disabled: false, delayBetweenMs: 0 },
  );

  assert.deepEqual(
    captured.map((c) => c.options?.resumeRunId),
    ['build-r1', 'build-r2'],
    'runIds must not cross-contaminate between dispatches',
  );
});

test('dispatchTakenOverRuns: disabled queue passes no runId (no dispatch)', async () => {
  const store = new InMemoryDurableStore();
  await seedOrphan(store, 'build-r1', [{ kind: 'step:started', stepId: 'clarify' }]);

  const captured: Captured[] = [];
  const stats = await dispatchTakenOverRuns(
    store,
    ['build-r1'],
    (project, feature, options) => void captured.push({ project, feature, options }),
    STAGES_BY_NAME,
    { disabled: true },
  );

  assert.equal(stats.dispatched, 0);
  assert.equal(captured.length, 0);
});
