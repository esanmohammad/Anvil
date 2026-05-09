/**
 * Phase A6 — attachLivenessPrefetchHook.
 *
 * Coverage:
 *   - probe is called once on pipeline:started.
 *   - rewind / restart re-fires pipeline:started → probe still only runs once
 *     (idempotent within the hook's lifetime).
 *   - probe failure does NOT fail the pipeline (fire-and-forget default).
 *   - await:true causes bus.emit to wait for the probe before returning.
 *   - onError captures probe rejections.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  attachLivenessPrefetchHook,
  type Step,
} from '../index.js';

function step(id: string): Step<unknown, unknown> {
  return { id, parallelism: 'serial', run: async () => id };
}

describe('attachLivenessPrefetchHook', () => {
  it('runs probe once on pipeline:started', async () => {
    let calls = 0;
    const bus = new InMemoryEventBus();
    const handle = attachLivenessPrefetchHook(bus, {
      probe: async () => { calls += 1; },
      await: true,
    });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.equal(calls, 1);
    assert.equal(handle.didProbe, true);
  });

  it('is idempotent across multiple pipeline:started emissions', async () => {
    let calls = 0;
    const bus = new InMemoryEventBus();
    attachLivenessPrefetchHook(bus, {
      probe: async () => { calls += 1; },
      await: true,
    });
    // Simulate rewind / restart by emitting pipeline:started twice.
    await bus.emit({ hook: 'pipeline:started', runId: 'r1', ts: '1' });
    await bus.emit({ hook: 'pipeline:started', runId: 'r1', ts: '2' });
    assert.equal(calls, 1);
  });

  it('fire-and-forget by default — probe failures do not fail the pipeline', async () => {
    const bus = new InMemoryEventBus();
    const errors: unknown[] = [];
    const handle = attachLivenessPrefetchHook(bus, {
      probe: async () => { throw new Error('liveness boom'); },
      onError: (e) => errors.push(e),
    });
    const reg = new InMemoryStepRegistry();
    reg.register(step('a'));
    const result = await new Pipeline({ registry: reg, bus, runId: 'r1', workspaceDir: '/tmp' }).run();
    // Give the fire-and-forget probe a tick to settle.
    await new Promise((r) => setImmediate(r));
    assert.equal(result.status, 'success');
    assert.ok(handle.didProbe);
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /liveness boom/);
  });

  it('await:true causes bus.emit to wait for the probe', async () => {
    const order: string[] = [];
    const bus = new InMemoryEventBus();
    attachLivenessPrefetchHook(bus, {
      probe: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('probe-done');
      },
      await: true,
    });
    bus.on('pipeline:started', () => { order.push('other-listener'); });
    await bus.emit({ hook: 'pipeline:started', runId: 'r1', ts: '1' });
    // Probe and other-listener both ran before emit returned.
    assert.ok(order.includes('probe-done'));
    assert.ok(order.includes('other-listener'));
  });

  it('records lastError when the probe rejects', async () => {
    const bus = new InMemoryEventBus();
    const handle = attachLivenessPrefetchHook(bus, {
      probe: async () => { throw new Error('cache miss'); },
      await: true,
    });
    await bus.emit({ hook: 'pipeline:started', runId: 'r1', ts: '1' });
    assert.match((handle.lastError as Error).message, /cache miss/);
  });

  it('unsubscribe stops further probe calls', async () => {
    let calls = 0;
    const bus = new InMemoryEventBus();
    const handle = attachLivenessPrefetchHook(bus, {
      probe: async () => { calls += 1; },
      await: true,
    });
    handle.unsubscribe();
    await bus.emit({ hook: 'pipeline:started', runId: 'r1', ts: '1' });
    assert.equal(calls, 0);
  });
});
