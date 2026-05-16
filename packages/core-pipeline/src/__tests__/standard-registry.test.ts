/**
 * Phase B — buildStandardStepRegistry.
 *
 * Coverage:
 *   - registers one Step per STAGES entry, in canonical order.
 *   - each Step.id matches stage.name; Step.name matches stage.label.
 *   - runStage is invoked once per stage with the prev-artifact threaded.
 *   - skipIfByStage wires Step.skipIf per stage; non-mapped stages run.
 *   - retryPolicy applies to all stages.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  Pipeline,
  STAGES,
  buildStandardStepRegistry,
  type RunStageFn,
} from '../index.js';

describe('buildStandardStepRegistry', () => {
  it('registers one Step per STAGES entry in canonical order', () => {
    const registry = buildStandardStepRegistry({
      runStage: async () => ({ artifact: '', cost: 0 }),
    });
    const ids = registry.steps().map((s) => s.id);
    assert.deepEqual(ids, STAGES.map((s) => s.name));
  });

  it('Step.name = stage.label, Step.id = stage.name', () => {
    const registry = buildStandardStepRegistry({
      runStage: async () => ({ artifact: '', cost: 0 }),
    });
    for (const step of registry.steps()) {
      const stage = STAGES.find((s) => s.name === step.id)!;
      assert.equal(step.id, stage.name);
      assert.equal(step.name, stage.label);
    }
  });

  it('runStage is invoked once per stage with the threaded prev-artifact', async () => {
    const calls: { stage: string; prev: string }[] = [];
    const runStage: RunStageFn = async (stageName, prevArtifact) => {
      calls.push({ stage: stageName, prev: prevArtifact });
      return { artifact: `${stageName}-out`, cost: 0 };
    };
    const registry = buildStandardStepRegistry({ runStage });
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      initialInput: '',
    }).run();
    assert.equal(result.status, 'success');
    assert.equal(calls.length, STAGES.length);
    // First stage receives '', subsequent stages receive the prior artifact.
    assert.equal(calls[0].prev, '');
    assert.equal(calls[1].prev, `${STAGES[0].name}-out`);
    assert.equal(calls.at(-1)!.prev, `${STAGES[STAGES.length - 2].name}-out`);
  });

  it('skipIfByStage skips only the named stages', async () => {
    const calls: string[] = [];
    const registry = buildStandardStepRegistry({
      runStage: async (name) => { calls.push(name); return { artifact: name, cost: 0 }; },
      skipIfByStage: {
        requirements: () => true,
        specs: () => true,
      },
    });
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
    }).run();
    assert.equal(result.status, 'success');
    assert.equal(calls.includes('requirements'), false);
    assert.equal(calls.includes('specs'), false);
    // First stage (clarify) and others all run.
    assert.equal(calls.includes('clarify'), true);
    assert.equal(calls.includes('build'), true);
  });

  it('skipIfByStage predicate sees ctx.shared from prior steps', async () => {
    let observed: Record<string, unknown> = {};
    const registry = buildStandardStepRegistry({
      runStage: async (name, _prev, ctx) => {
        if (name === 'clarify') {
          (ctx.shared as Record<string, unknown>).planSeed = { id: 1 };
        }
        return { artifact: name, cost: 0 };
      },
      skipIfByStage: {
        requirements: (ctx) => {
          observed = ctx.shared;
          return ctx.shared.planSeed != null;
        },
      },
    });
    await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
    }).run();
    assert.deepEqual(observed, { planSeed: { id: 1 } });
  });

  it('retryPolicy applies to every stage', async () => {
    let attempts = 0;
    const registry = buildStandardStepRegistry({
      runStage: async (name) => {
        if (name === 'clarify' && attempts++ === 0) throw new Error('transient');
        return { artifact: name, cost: 0 };
      },
      retryPolicy: { attempts: 1, backoff: 'constant', baseMs: 0 },
    });
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      sleep: async () => {},
    }).run();
    assert.equal(result.status, 'success');
    assert.equal(attempts, 2, 'first attempt failed; retry succeeded');
  });
});
