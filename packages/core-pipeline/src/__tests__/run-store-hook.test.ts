/**
 * Phase 4 — run-store hook unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import { attachRunStoreHook } from '../hooks/run-store.hook.js';
import type { RunStoreLike } from '../hooks/run-store.hook.js';

function fakeStore(): RunStoreLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    updateStage: (args) => { calls.push(['stage', args]); },
    updateRun: (args) => { calls.push(['run', args]); },
  };
}

describe('attachRunStoreHook', () => {
  it('records step:started → updateStage(running)', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'a', ts: '' });
    assert.deepEqual(store.calls, [
      ['stage', { runId: 'r1', stepId: 'a', status: 'running' }],
    ]);
  });

  it('records step:completed with durationMs', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({
      hook: 'step:completed', runId: 'r1', stepId: 'a', ts: '',
      payload: { durationMs: 42 },
    });
    assert.deepEqual(store.calls[0], [
      'stage', { runId: 'r1', stepId: 'a', status: 'completed', durationMs: 42 },
    ]);
  });

  it('records step:failed with error', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({
      hook: 'step:failed', runId: 'r1', stepId: 'a', ts: '',
      error: { message: 'boom' },
    });
    assert.deepEqual(store.calls[0], [
      'stage', { runId: 'r1', stepId: 'a', status: 'failed', error: { message: 'boom' } },
    ]);
  });

  it('records step:skipped', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({ hook: 'step:skipped', runId: 'r1', stepId: 'a', ts: '' });
    assert.deepEqual(store.calls[0], [
      'stage', { runId: 'r1', stepId: 'a', status: 'skipped' },
    ]);
  });

  it('records pipeline:completed → updateRun(completed)', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({
      hook: 'pipeline:completed', runId: 'r1', ts: '',
      payload: { durationMs: 100 },
    });
    assert.deepEqual(store.calls[0], [
      'run', { runId: 'r1', status: 'completed', durationMs: 100 },
    ]);
  });

  it('records pipeline:failed → updateRun(failed) with error', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({
      hook: 'pipeline:failed', runId: 'r1', ts: '',
      payload: { durationMs: 50 },
      error: { message: 'oops' },
    });
    assert.deepEqual(store.calls[0], [
      'run', { runId: 'r1', status: 'failed', durationMs: 50, error: { message: 'oops' } },
    ]);
  });

  it('ignores events for a different runId', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({ hook: 'step:started', runId: 'r2', stepId: 'a', ts: '' });
    assert.deepEqual(store.calls, []);
  });

  it('captures store.updateStage throws — pipeline does not crash', async () => {
    const bus = new InMemoryEventBus();
    const store: RunStoreLike = {
      updateStage: () => { throw new Error('disk full'); },
      updateRun: () => undefined,
    };
    const handle = attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'a', ts: '' });
    assert.ok(handle.lastError);
    assert.match(handle.lastError!.message, /disk full/);
  });

  it('unsubscribe stops listening', async () => {
    const bus = new InMemoryEventBus();
    const store = fakeStore();
    const handle = attachRunStoreHook(bus, { runStore: store, runId: 'r1' });
    handle.unsubscribe();
    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'a', ts: '' });
    assert.deepEqual(store.calls, []);
  });
});
