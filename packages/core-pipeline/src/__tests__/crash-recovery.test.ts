/**
 * Phase D2 — end-to-end crash recovery via `Pipeline.run()`.
 *
 * Two passes against the same `runId` + `durableStore`:
 *   - Pass 1: step-1 completes; step-2 runs effect A
 *     (recorded), then throws *outside* of any effect call —
 *     simulating a step body that hits a synchronous bug.
 *     `step:failed` is recorded; effect B is never reached.
 *   - Pass 2: pipeline opens the same store, sees step-1 +
 *     `step:completed` in the log → emits `step:skipped`
 *     with reason `replay-completed`.
 *     Step-2 re-runs from the top; effect A returns the
 *     recorded value (fn NOT invoked); execution proceeds past
 *     the replay frontier and effect B runs live.
 *
 * Mid-effect crash recovery (effect:started written, then `kill
 * -9` before effect:completed) is covered by
 * `effect-runtime.test.ts` directly — that condition is
 * synthesised by writing the started event manually since we
 * can't actually crash a Node process inside a test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import { InMemoryStepRegistry } from '../step-registry.js';
import { Pipeline } from '../pipeline.js';
import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import type { Step } from '../types.js';
import { attachDurableLogHook } from '../hooks/durable-log.hook.js';

interface Counters {
  step1: number;
  step2: number;
  step3: number;
  effectA1: number;
  effectA2: number;
  effectB: number;
}

const RUN_ID = 'run-crash';

function makeRegistry(counters: Counters, throwAfterEffectA: boolean) {
  const reg = new InMemoryStepRegistry();
  const step1: Step<unknown, string> = {
    id: 'step-1',
    async run(ctx) {
      counters.step1 += 1;
      return ctx.effect('eA', async () => {
        counters.effectA1 += 1;
        return 'A-step1';
      });
    },
  };
  const step2: Step<string, string> = {
    id: 'step-2',
    async run(ctx) {
      counters.step2 += 1;
      const a = await ctx.effect('eA', async () => {
        counters.effectA2 += 1;
        return 'A-step2';
      });
      if (throwAfterEffectA) {
        throw new Error('crash post effect A');
      }
      const b = await ctx.effect('eB', async () => {
        counters.effectB += 1;
        return 'B-out';
      });
      return `${a}|${b}`;
    },
  };
  const step3: Step<string, string> = {
    id: 'step-3',
    async run() {
      counters.step3 += 1;
      return 'done';
    },
  };
  reg.register(step1 as Step<unknown, unknown>);
  reg.register(step2 as Step<unknown, unknown>);
  reg.register(step3 as Step<unknown, unknown>);
  return reg;
}

describe('Pipeline + DurableStore — crash recovery', () => {
  it('replays completed steps + skips already-recorded effects', async () => {
    const store = new InMemoryDurableStore();
    await store.createRun({ runId: RUN_ID, project: 'p', feature: 'f', featureSlug: 'f' });
    const counters: Counters = { step1: 0, step2: 0, step3: 0, effectA1: 0, effectA2: 0, effectB: 0 };

    // ── Pass 1: throws after effect A in step-2 ─────────────────
    {
      const bus = new InMemoryEventBus();
      attachDurableLogHook(bus, store, RUN_ID);
      const reg = makeRegistry(counters, /* throwAfterEffectA */ true);
      const pipeline = new Pipeline({
        registry: reg,
        bus,
        runId: RUN_ID,
        workspaceDir: '/tmp',
        durableStore: store,
      });
      const result = await pipeline.run();
      assert.equal(result.status, 'failed');
      assert.equal(result.failedStep, 'step-2');
    }

    assert.equal(counters.step1, 1);
    assert.equal(counters.step2, 1);
    assert.equal(counters.effectA1, 1);
    assert.equal(counters.effectA2, 1);
    assert.equal(counters.effectB, 0);
    assert.equal(counters.step3, 0);

    // ── Pass 2: restart with same store. Step-1 must skip;
    //         step-2 effect A replays (no fn call); effect B runs live.
    {
      const bus = new InMemoryEventBus();
      attachDurableLogHook(bus, store, RUN_ID);
      const reg = makeRegistry(counters, /* throwAfterEffectA */ false);
      const pipeline = new Pipeline({
        registry: reg,
        bus,
        runId: RUN_ID,
        workspaceDir: '/tmp',
        durableStore: store,
      });
      const skipped: string[] = [];
      bus.on('step:skipped', (ev) => {
        if (ev.stepId) skipped.push(ev.stepId);
      });
      const result = await pipeline.run();
      assert.equal(result.status, 'success');
      assert.deepEqual(skipped, ['step-1']);
    }

    assert.equal(counters.step1, 1);
    assert.equal(counters.step2, 2);
    assert.equal(counters.effectA1, 1);
    assert.equal(counters.effectA2, 1); // replayed, not re-invoked
    assert.equal(counters.effectB, 1);
    assert.equal(counters.step3, 1);
  });
});

describe('Pipeline + DurableStore — non-durable mode is unchanged', () => {
  it('runs without a store and step bodies still work', async () => {
    const counters: Counters = { step1: 0, step2: 0, step3: 0, effectA: 0, effectB: 0 };
    const reg = makeRegistry(counters, /* throwOnEffectB */ false);
    const bus = new InMemoryEventBus();
    const pipeline = new Pipeline({
      registry: reg,
      bus,
      runId: 'no-durable',
      workspaceDir: '/tmp',
    });
    const result = await pipeline.run();
    assert.equal(result.status, 'success');
    assert.equal(counters.step1, 1);
    assert.equal(counters.step3, 1);
  });
});
