/**
 * Phase 2 — EventBus mature behavior.
 *
 * Coverage:
 *   - emit awaits async listeners
 *   - listener throw is isolated (subsequent listeners still run; emit
 *     rejects with AggregateError after all complete)
 *   - emitFireAndForget never blocks; rejections swallowed
 *   - off / once / unsubscribe-handle removal
 *   - priority ordering (descending priority, FIFO tie-break)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import type { PipelineEvent } from '../types.js';

const make = (overrides: Partial<PipelineEvent> = {}): PipelineEvent => ({
  hook: 'step:started',
  runId: 'r1',
  ts: '2026-04-29T00:00:00.000Z',
  ...overrides,
});

describe('InMemoryEventBus (Phase 2)', () => {
  it('awaits async listeners before emit resolves', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    bus.on('step:started', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('listener');
    });
    await bus.emit(make());
    order.push('after-emit');
    assert.deepEqual(order, ['listener', 'after-emit']);
  });

  it('isolates listener throws — every listener runs; emit rejects after', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.on('step:completed', () => {
      seen.push('a');
    });
    bus.on('step:completed', () => {
      seen.push('b');
      throw new Error('boom');
    });
    bus.on('step:completed', () => {
      seen.push('c');
    });
    await assert.rejects(bus.emit(make({ hook: 'step:completed' })), /boom/);
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });

  it('AggregateErrors when multiple listeners throw', async () => {
    const bus = new InMemoryEventBus();
    bus.on('step:failed', () => {
      throw new Error('e1');
    });
    bus.on('step:failed', () => {
      throw new Error('e2');
    });
    await assert.rejects(bus.emit(make({ hook: 'step:failed' })), (err: unknown) => {
      assert.ok(err instanceof AggregateError);
      assert.equal((err as AggregateError).errors.length, 2);
      return true;
    });
  });

  it('emitFireAndForget never blocks; async rejections silently swallowed', () => {
    const bus = new InMemoryEventBus();
    let saw = 0;
    bus.on('artifact:emitted', async () => {
      await new Promise((r) => setTimeout(r, 10));
      saw++;
      throw new Error('async-fail');
    });
    bus.emitFireAndForget(make({ hook: 'artifact:emitted' }));
    assert.equal(saw, 0, 'fire-and-forget did not block');
  });

  it('off and unsubscribe-handle both remove the listener', async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    const lA = (): void => {
      count++;
    };
    bus.on('step:started', lA);
    const offB = bus.on('step:started', () => {
      count++;
    });
    await bus.emit(make());
    assert.equal(count, 2);
    bus.off('step:started', lA);
    offB();
    await bus.emit(make());
    assert.equal(count, 2, 'both listeners removed');
  });

  it('once auto-unsubscribes after first delivery', async () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    bus.once('step:started', () => {
      count++;
    });
    await bus.emit(make());
    await bus.emit(make());
    assert.equal(count, 1);
  });

  it('priority ordering: high → low, FIFO tie-break at equal priority', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];
    bus.on(
      'step:completed',
      () => {
        order.push('default');
      },
      // default priority 0
    );
    bus.on(
      'step:completed',
      () => {
        order.push('audit');
      },
      { priority: 100 },
    );
    bus.on(
      'step:completed',
      () => {
        order.push('learners');
      },
      { priority: 50 },
    );
    bus.on(
      'step:completed',
      () => {
        order.push('default-2');
      },
      // default 0; tie-break vs first 'default' by FIFO
    );
    await bus.emit(make({ hook: 'step:completed' }));
    assert.deepEqual(order, ['audit', 'learners', 'default', 'default-2']);
  });
});
