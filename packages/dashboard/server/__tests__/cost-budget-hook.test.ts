/**
 * Phase 4e tests — `attachCostBudgetHook` invokes
 * `CostBreachHandler.evaluate` on `step:completed` for the configured
 * runId, with the policy resolved at evaluation time.
 *
 * Uses a fake breach handler so we don't pull in the full CostLedger
 * + sqlite stack — the hook contract is what matters here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryEventBus,
  makePipelineEvent,
} from '@anvil/core-pipeline';

import { attachCostBudgetHook } from '../steps/index.js';
import type { CostBreachHandler, CostPolicy } from '../cost-breach-handler.js';

interface EvalCall {
  runId: string;
  project: string;
  policy: CostPolicy;
}

function fakeBreachHandler(): {
  handler: CostBreachHandler;
  calls: EvalCall[];
  failNext: () => void;
} {
  const calls: EvalCall[] = [];
  let shouldFail = false;
  const handler = {
    async evaluate(runId: string, project: string, policy: CostPolicy) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('disk full');
      }
      calls.push({ runId, project, policy });
      return null;
    },
  } as unknown as CostBreachHandler;
  return {
    handler,
    calls,
    failNext: () => {
      shouldFail = true;
    },
  };
}

const POLICY: CostPolicy = {
  limits: { perRun: 1, perProjectDaily: 5 },
  graceWindowSeconds: 60,
  onBreach: 'ask',
};

describe('attachCostBudgetHook — Phase 4e', () => {
  it('evaluates on step:completed for the matching runId', async () => {
    const bus = new InMemoryEventBus();
    const { handler, calls } = fakeBreachHandler();
    const handle = attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => POLICY,
    });

    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(handle.evaluationCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runId, 'run-1');
    assert.equal(calls[0].project, 'demo');
    assert.deepEqual(calls[0].policy.limits, POLICY.limits);
    handle.unsubscribe();
  });

  it('ignores events for a different runId', async () => {
    const bus = new InMemoryEventBus();
    const { handler, calls } = fakeBreachHandler();
    attachCostBudgetHook(bus, {
      runId: 'run-A',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => POLICY,
    });

    await bus.emit(makePipelineEvent('step:completed', 'run-B', undefined, 'plan'));
    assert.equal(calls.length, 0);
  });

  it('skips evaluation when resolvePolicy returns null', async () => {
    const bus = new InMemoryEventBus();
    const { handler, calls } = fakeBreachHandler();
    const handle = attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => null,
    });

    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(handle.evaluationCount, 0);
    assert.equal(calls.length, 0);
  });

  it('only fires on step:completed (not step:started, sub-step:*, pipeline:*)', async () => {
    const bus = new InMemoryEventBus();
    const { handler, calls } = fakeBreachHandler();
    attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => POLICY,
    });

    await bus.emit(makePipelineEvent('step:started', 'run-1', undefined, 'plan'));
    await bus.emit(makePipelineEvent('sub-step:started', 'run-1', undefined, 'inner'));
    await bus.emit(makePipelineEvent('sub-step:completed', 'run-1', undefined, 'inner'));
    await bus.emit(makePipelineEvent('pipeline:started', 'run-1'));
    await bus.emit(makePipelineEvent('pipeline:completed', 'run-1'));
    assert.equal(calls.length, 0);

    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(calls.length, 1);
  });

  it('isolates resolvePolicy throws via onError', async () => {
    const bus = new InMemoryEventBus();
    const { handler, calls } = fakeBreachHandler();
    const errors: unknown[] = [];
    attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => { throw new Error('yaml parse fail'); },
      onError: (err) => errors.push(err),
    });

    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(calls.length, 0);
    assert.equal(errors.length, 1);
  });

  it('isolates breachHandler.evaluate throws via onError', async () => {
    const bus = new InMemoryEventBus();
    const fake = fakeBreachHandler();
    const errors: unknown[] = [];
    attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: fake.handler,
      resolvePolicy: () => POLICY,
      onError: (err) => errors.push(err),
    });

    fake.failNext();
    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(errors.length, 1);
  });

  it('unsubscribes cleanly', async () => {
    const bus = new InMemoryEventBus();
    const { handler, calls } = fakeBreachHandler();
    const handle = attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => POLICY,
    });

    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(calls.length, 1);
    handle.unsubscribe();
    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));
    assert.equal(calls.length, 1);
  });

  it('respects priority override (default 30, listener-order check)', async () => {
    const bus = new InMemoryEventBus();
    const order: string[] = [];

    bus.on('step:completed', () => { order.push('priority-100'); }, { priority: 100 });
    bus.on('step:completed', () => { order.push('priority-10'); }, { priority: 10 });
    const { handler } = fakeBreachHandler();
    attachCostBudgetHook(bus, {
      runId: 'run-1',
      project: 'demo',
      breachHandler: handler,
      resolvePolicy: () => POLICY,
    });
    bus.on('step:completed', () => { order.push('priority-30-after'); }, { priority: 30 });

    await bus.emit(makePipelineEvent('step:completed', 'run-1', undefined, 'plan'));

    // Higher priority fires first.
    assert.equal(order[0], 'priority-100');
    // Default 30 sits in the middle.
    assert.ok(order.indexOf('priority-100') < order.indexOf('priority-10'));
  });
});
