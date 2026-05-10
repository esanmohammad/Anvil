/**
 * Phase D4 — step versioning + compensation.
 *
 * Two scenarios exercised end-to-end via Pipeline.run() against
 * an InMemoryDurableStore:
 *   - Version bump between two runs of the same runId surfaces a
 *     DeterminismViolationError(reason: 'version-mismatch').
 *   - On run failure, completed steps' compensate(ctx, output) hooks
 *     are invoked in reverse order; the failed step is skipped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import { InMemoryStepRegistry } from '../step-registry.js';
import { Pipeline } from '../pipeline.js';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import { DeterminismViolationError } from '../durable/types.js';
import { attachDurableLogHook } from '../hooks/durable-log.hook.js';
import type { Step } from '../types.js';

const RUN_ID = 'run-d4';

function newStore() {
  return (async () => {
    const s = new InMemoryDurableStore();
    await s.createRun({ runId: RUN_ID, project: 'p', feature: 'f', featureSlug: 'f' });
    return s;
  })();
}

describe('Phase D4 — step versioning', () => {
  it('replay with bumped version throws DeterminismViolationError', async () => {
    const store = await newStore();

    // Pass 1: step with version 1 records and completes.
    {
      const reg = new InMemoryStepRegistry();
      const step: Step<unknown, string> = {
        id: 'sV',
        version: 1,
        async run() {
          return 'done';
        },
      };
      reg.register(step as Step<unknown, unknown>);
      const bus = new InMemoryEventBus();
      attachDurableLogHook(bus, store, RUN_ID);
      const pipeline = new Pipeline({
        registry: reg,
        bus,
        runId: RUN_ID,
        workspaceDir: '/tmp',
        durableStore: store,
      });
      const r = await pipeline.run();
      assert.equal(r.status, 'success');
    }

    // Pass 2: same runId, but step version bumped to 2. The replay
    // path catches the mismatch.
    {
      const reg = new InMemoryStepRegistry();
      const step: Step<unknown, string> = {
        id: 'sV',
        version: 2,
        async run() {
          return 'done-v2';
        },
      };
      reg.register(step as Step<unknown, unknown>);
      const bus = new InMemoryEventBus();
      attachDurableLogHook(bus, store, RUN_ID);
      const pipeline = new Pipeline({
        registry: reg,
        bus,
        runId: RUN_ID + '-bumped',
        workspaceDir: '/tmp',
        durableStore: store,
      });
      // Recreate the run row so the second runId exists
      await store.createRun({ runId: RUN_ID + '-bumped', project: 'p', feature: 'f', featureSlug: 'f' });
      // Seed a v1 record under the same runId
      await store.appendEvent({
        runId: RUN_ID + '-bumped',
        kind: 'step:started',
        stepId: 'sV',
        payload: { version: 1 },
      });
      await assert.rejects(() => pipeline.run(), DeterminismViolationError);
    }
  });
});

describe('Phase D4 — compensation walk', () => {
  it('invokes compensate hooks in reverse order on failure', async () => {
    const order: string[] = [];
    const reg = new InMemoryStepRegistry();
    const stepA: Step<unknown, { a: number }> = {
      id: 'A',
      async run() {
        return { a: 1 };
      },
      async compensate(_ctx, output) {
        order.push(`A:${output.a}`);
      },
    };
    const stepB: Step<{ a: number }, { b: string }> = {
      id: 'B',
      async run(ctx) {
        return { b: `b-${ctx.input.a}` };
      },
      async compensate(_ctx, output) {
        order.push(`B:${output.b}`);
      },
    };
    const stepC: Step<{ b: string }, never> = {
      id: 'C',
      async run() {
        throw new Error('C-fails');
      },
    };
    reg.register(stepA as Step<unknown, unknown>);
    reg.register(stepB as Step<unknown, unknown>);
    reg.register(stepC as Step<unknown, unknown>);

    const bus = new InMemoryEventBus();
    const pipeline = new Pipeline({
      registry: reg,
      bus,
      runId: 'run-comp',
      workspaceDir: '/tmp',
    });
    const r = await pipeline.run();
    assert.equal(r.status, 'failed');
    assert.equal(r.failedStep, 'C');
    // Reverse order: B first, then A. C never produced an output.
    assert.deepEqual(order, ['B:b-1', 'A:1']);
  });

  it('does not run compensate when run succeeds', async () => {
    const compensated: string[] = [];
    const reg = new InMemoryStepRegistry();
    const stepA: Step<unknown, string> = {
      id: 'A',
      async run() {
        return 'a-out';
      },
      async compensate() {
        compensated.push('A');
      },
    };
    reg.register(stepA as Step<unknown, unknown>);
    const bus = new InMemoryEventBus();
    const pipeline = new Pipeline({
      registry: reg,
      bus,
      runId: 'run-comp-success',
      workspaceDir: '/tmp',
    });
    const r = await pipeline.run();
    assert.equal(r.status, 'success');
    assert.deepEqual(compensated, []);
  });

  it('survives a throw inside compensate and continues walking', async () => {
    const order: string[] = [];
    const reg = new InMemoryStepRegistry();
    const stepA: Step<unknown, string> = {
      id: 'A',
      async run() {
        return 'a-out';
      },
      async compensate() {
        order.push('A-ok');
      },
    };
    const stepB: Step<unknown, string> = {
      id: 'B',
      async run() {
        return 'b-out';
      },
      async compensate() {
        throw new Error('B-compensate-fails');
      },
    };
    const stepC: Step<unknown, never> = {
      id: 'C',
      async run() {
        throw new Error('C-fails');
      },
    };
    reg.register(stepA as Step<unknown, unknown>);
    reg.register(stepB as Step<unknown, unknown>);
    reg.register(stepC as Step<unknown, unknown>);
    const bus = new InMemoryEventBus();
    const pipeline = new Pipeline({
      registry: reg,
      bus,
      runId: 'run-comp-throw',
      workspaceDir: '/tmp',
    });
    const r = await pipeline.run();
    assert.equal(r.status, 'failed');
    // B's compensate threw, but A's still ran.
    assert.deepEqual(order, ['A-ok']);
  });
});
