/**
 * Phase 7 — sub-step recursion + retry policy.
 *
 * Coverage:
 *   - subSteps run sequentially before parent.run; sub-step:started /
 *     sub-step:completed events fire with parentStepId in payload
 *   - sub-step failure surfaces as parent step:failed
 *   - retryPolicy retries up to `attempts` times with exponential backoff
 *   - retryOn predicate gates retries
 *   - retry exhaustion raises the last error
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type PipelineEvent,
  type Step,
} from '../index.js';

function recordEvents(bus: InMemoryEventBus, into: PipelineEvent[]): void {
  const hooks: PipelineEvent['hook'][] = [
    'pipeline:started',
    'pipeline:completed',
    'pipeline:failed',
    'step:started',
    'step:completed',
    'step:failed',
    'step:retried',
    'sub-step:started',
    'sub-step:completed',
  ];
  for (const h of hooks) {
    bus.on(h, (e) => {
      into.push(e);
    });
  }
}

describe('sub-step recursion (Phase 7)', () => {
  it('runs subSteps sequentially before parent.run; emits sub-step:* events', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const events: PipelineEvent[] = [];
    recordEvents(bus, events);

    const order: string[] = [];
    const sub1: Step<unknown, unknown> = {
      id: 'check-lint',
      run: async () => {
        order.push('sub1');
        return 'lint-out';
      },
    };
    const sub2: Step<unknown, unknown> = {
      id: 'check-test',
      run: async () => {
        order.push('sub2');
        return 'test-out';
      },
    };
    reg.register({
      id: 'validate',
      subSteps: [sub1, sub2],
      run: async (ctx) => {
        order.push('parent');
        return { fromParent: ctx.input };
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({ bus, registry: reg, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.equal(result.status, 'success');
    assert.deepEqual(order, ['sub1', 'sub2', 'parent']);

    const subStarted = events.filter((e) => e.hook === 'sub-step:started');
    const subCompleted = events.filter((e) => e.hook === 'sub-step:completed');
    assert.equal(subStarted.length, 2);
    assert.equal(subCompleted.length, 2);
    assert.equal(
      (subStarted[0].payload as { parentStepId: string }).parentStepId,
      'validate',
    );
  });

  it('sub-step failure bubbles up as parent step:failed', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const events: PipelineEvent[] = [];
    recordEvents(bus, events);

    const failing: Step<unknown, unknown> = {
      id: 'check-lint',
      run: async () => {
        throw new Error('lint-broke');
      },
    };
    let parentRan = false;
    reg.register({
      id: 'validate',
      subSteps: [failing],
      run: async () => {
        parentRan = true;
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({ bus, registry: reg, runId: 'r2', workspaceDir: '/tmp' }).run();
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 'validate');
    assert.equal(parentRan, false);
    const subFailed = events.find((e) => e.hook === 'sub-step:completed' && (e.payload as { failed?: boolean }).failed);
    assert.ok(subFailed);
  });
});

describe('Step.retryPolicy (Phase 7)', () => {
  it('retries up to `attempts` times with exponential backoff', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const events: PipelineEvent[] = [];
    recordEvents(bus, events);

    let calls = 0;
    const sleeps: number[] = [];
    reg.register({
      id: 'flaky',
      retryPolicy: { attempts: 3, backoff: 'exponential', baseMs: 10 },
      run: async () => {
        calls += 1;
        if (calls < 3) throw new Error(`fail-${calls}`);
        return 'ok';
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({
      bus,
      registry: reg,
      runId: 'r3',
      workspaceDir: '/tmp',
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).run();
    assert.equal(result.status, 'success');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [10, 20]);
    const retries = events.filter((e) => e.hook === 'step:retried');
    assert.equal(retries.length, 2);
  });

  it('retryOn predicate gates retries — false bypasses retry', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    let calls = 0;
    reg.register({
      id: 'terminal',
      retryPolicy: {
        attempts: 5,
        backoff: 'constant',
        baseMs: 1,
        retryOn: (err) => (err as Error).message.includes('transient'),
      },
      run: async () => {
        calls += 1;
        throw new Error('terminal-error');
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({
      bus,
      registry: reg,
      runId: 'r4',
      workspaceDir: '/tmp',
      sleep: async () => {},
    }).run();
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
  });

  it('retry exhaustion surfaces as step:failed', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    let calls = 0;
    reg.register({
      id: 'always-fails',
      retryPolicy: { attempts: 2, backoff: 'constant', baseMs: 1 },
      run: async () => {
        calls += 1;
        throw new Error('boom');
      },
    } as Step<unknown, unknown>);

    const result = await new Pipeline({
      bus,
      registry: reg,
      runId: 'r5',
      workspaceDir: '/tmp',
      sleep: async () => {},
    }).run();
    assert.equal(result.status, 'failed');
    assert.equal(calls, 3, 'attempts=2 means 3 total invocations (1 initial + 2 retries)');
    assert.equal(result.failedStep, 'always-fails');
  });
});
