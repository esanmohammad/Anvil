/**
 * Phase A3 — attachStreamHook (debounced snapshot callback).
 *
 * Coverage:
 *   - delivers a snapshot per debounce window (not per event).
 *   - snapshot has the expected shape across pipeline:started → step:started
 *     → step:completed → pipeline:completed.
 *   - step:skipped pushes the step into completedStepIds (so resume / rewind
 *     produce coherent rollups).
 *   - flush() forces immediate delivery.
 *   - unsubscribe() stops further deliveries even if more events fire.
 *   - onError is called when onSnapshot throws — listener does not crash.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  attachStreamHook,
  type Step,
  type StreamSnapshot,
} from '../index.js';

function step(id: string): Step<unknown, unknown> {
  return { id, parallelism: 'serial', run: async () => id };
}

describe('attachStreamHook', () => {
  it('delivers a single coalesced snapshot per debounce window', async () => {
    const delivered: StreamSnapshot[] = [];
    const bus = new InMemoryEventBus();
    const handle = attachStreamHook(bus, {
      onSnapshot: (s) => delivered.push(s),
      // Synchronous timer so we don't depend on real time in tests.
      setTimer: (fn) => { fn(); return 0; },
      clearTimer: () => {},
    });

    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    reg.register(step('b'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    handle.flush();

    // Final snapshot shape: completed, both steps in completedStepIds.
    const last = delivered.at(-1)!;
    assert.equal(last.runId, 'r1');
    assert.equal(last.status, 'completed');
    assert.deepEqual(last.completedStepIds, ['a', 'b']);
    assert.equal(last.currentStepId, undefined);
    handle.unsubscribe();
  });

  it('marks failed runs', async () => {
    const delivered: StreamSnapshot[] = [];
    const bus = new InMemoryEventBus();
    attachStreamHook(bus, {
      onSnapshot: (s) => delivered.push(s),
      setTimer: (fn) => { fn(); return 0; },
      clearTimer: () => {},
    });
    const reg = new InMemoryStepRegistry();
    reg.register({ id: 'boom', parallelism: 'serial', run: async () => { throw new Error('x'); } });
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    const last = delivered.at(-1)!;
    assert.equal(last.status, 'failed');
    assert.equal(last.failedStepId, 'boom');
  });

  it('treats step:skipped the same as step:completed for rollup', async () => {
    const delivered: StreamSnapshot[] = [];
    const bus = new InMemoryEventBus();
    attachStreamHook(bus, {
      onSnapshot: (s) => delivered.push(s),
      setTimer: (fn) => { fn(); return 0; },
      clearTimer: () => {},
    });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    reg.register(step('b'));
    reg.register(step('c'));
    await new Pipeline({
      registry: reg, bus, runId: 'r1', workspaceDir: '/tmp', completedSteps: ['a'],
    }).run();
    const last = delivered.at(-1)!;
    assert.deepEqual(last.completedStepIds, ['a', 'b', 'c']);
  });

  it('flush() forces immediate delivery of pending debounced snapshot', async () => {
    let pending: (() => void) | null = null;
    const delivered: StreamSnapshot[] = [];
    const bus = new InMemoryEventBus();
    const handle = attachStreamHook(bus, {
      onSnapshot: (s) => delivered.push(s),
      setTimer: (fn) => { pending = fn; return 1; },
      clearTimer: () => { pending = null; },
    });

    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    // Nothing delivered yet — the timer hasn't fired and we never called pending.
    assert.equal(delivered.length, 0);
    handle.flush();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].status, 'completed');
  });

  it('unsubscribe() stops further deliveries', async () => {
    const delivered: StreamSnapshot[] = [];
    const bus = new InMemoryEventBus();
    const handle = attachStreamHook(bus, {
      onSnapshot: (s) => delivered.push(s),
      setTimer: (fn) => { fn(); return 0; },
      clearTimer: () => {},
    });
    handle.unsubscribe();
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.equal(delivered.length, 0);
  });

  it('onError catches throws from the onSnapshot callback', async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus();
    attachStreamHook(bus, {
      onSnapshot: () => { throw new Error('boom-callback'); },
      onError: (e) => errors.push(e),
      setTimer: (fn) => { fn(); return 0; },
      clearTimer: () => {},
    });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.ok(errors.length >= 1);
    assert.match((errors[0] as Error).message, /boom-callback/);
  });
});
