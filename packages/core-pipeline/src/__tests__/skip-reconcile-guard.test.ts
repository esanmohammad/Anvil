/**
 * FO1-1b guard — the reconciliation warning in Pipeline.run only fires
 * for a genuine disk-vs-durable disagreement on a REUSED runId.
 *
 * Review findings 3 + 4: the divergence compare must be suppressed when
 *   - the durable log is empty (a fresh runId was minted → every disk
 *     step would falsely read as `onlyDisk`), and
 *   - the run is a rewind (rewindTo deliberately drops trailing steps).
 *
 * These pin the guard by capturing console.warn around Pipeline.run.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../pipeline.js';
import { InMemoryEventBus } from '../event-bus.js';
import { InMemoryStepRegistry } from '../step-registry.js';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import type { Step } from '../types.js';

function step(id: string, runs: string[]): Step<unknown, unknown> {
  return {
    id,
    parallelism: 'serial',
    run: async () => {
      runs.push(id);
      return id;
    },
  };
}

function buildRegistry(ids: string[], runs: string[]): InMemoryStepRegistry {
  const reg = new InMemoryStepRegistry();
  for (const id of ids) reg.register(step(id, runs));
  return reg;
}

/** Seed a durable log with step:completed for the given steps. */
async function seedCompleted(store: InMemoryDurableStore, runId: string, completed: string[]) {
  await store.createRun({ runId, project: 'p', feature: 'f', featureSlug: 'f' });
  for (const id of completed) {
    await store.appendEvent({ runId, kind: 'step:completed', stepId: id, payload: {} });
  }
}

describe('Pipeline.run — skip-set reconciliation guard', () => {
  let warnings: string[];
  let origWarn: typeof console.warn;

  beforeEach(() => {
    warnings = [];
    origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.warn = origWarn;
  });

  const divergenceWarnings = () => warnings.filter((w) => w.includes('skip-set divergence'));

  it('warns on a genuine divergence (disk says done, durable does not)', async () => {
    const runs: string[] = [];
    const store = new InMemoryDurableStore();
    await seedCompleted(store, 'r1', ['a', 'b']); // durable: a,b done
    const registry = buildRegistry(['a', 'b', 'c', 'd'], runs);
    await new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'r1',
      workspaceDir: '/tmp',
      durableStore: store,
      completedSteps: ['a', 'b', 'c'], // disk claims c too → onlyDisk=[c]
    }).run();

    assert.equal(divergenceWarnings().length, 1);
    assert.match(divergenceWarnings()[0], /disk-only=\[c\]/);
  });

  it('does NOT warn when the durable log is empty (fresh runId — no reuse)', async () => {
    const runs: string[] = [];
    const store = new InMemoryDurableStore();
    await store.createRun({ runId: 'r2', project: 'p', feature: 'f', featureSlug: 'f' }); // empty log
    const registry = buildRegistry(['a', 'b', 'c'], runs);
    await new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'r2',
      workspaceDir: '/tmp',
      durableStore: store,
      completedSteps: ['a', 'b'], // disk set non-empty but durable empty
    }).run();

    assert.equal(divergenceWarnings().length, 0, 'must not flag every disk step as divergence');
  });

  it('does NOT warn when disk and durable agree', async () => {
    const runs: string[] = [];
    const store = new InMemoryDurableStore();
    await seedCompleted(store, 'r3', ['a', 'b']);
    const registry = buildRegistry(['a', 'b', 'c'], runs);
    await new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'r3',
      workspaceDir: '/tmp',
      durableStore: store,
      completedSteps: ['a', 'b'],
    }).run();

    assert.equal(divergenceWarnings().length, 0);
  });

  it('does NOT warn on a rewind pass (trailing steps are intentionally dropped)', async () => {
    const runs: string[] = [];
    const store = new InMemoryDurableStore();
    await seedCompleted(store, 'r4', ['a', 'b']); // durable: a,b
    const registry = buildRegistry(['a', 'b', 'c'], runs);
    await new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'r4',
      workspaceDir: '/tmp',
      durableStore: store,
      completedSteps: ['a', 'b', 'c'], // disk has c; rewind drops it
      rewindTo: 'b',
    }).run();

    assert.equal(divergenceWarnings().length, 0, 'rewind-dropped steps are not a divergence');
  });
});
