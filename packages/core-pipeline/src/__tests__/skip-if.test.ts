/**
 * Phase A1 — Step.skipIf walker support.
 *
 * Coverage:
 *   - skipIf returns true   → step:skipped fires with reason 'skipIf',
 *                             step.run() never called, prevOutput threads
 *                             through to next step's input.
 *   - skipIf returns false  → step runs normally.
 *   - skipIf throws         → terminal failure (step:failed), pipeline
 *                             stops; the walker does NOT silently
 *                             fall through to step.run().
 *   - skipIf reads ctx.shared and ctx.artifacts.
 *   - skipIf is consulted AFTER the resume / completedSteps skip set
 *     (so it cannot un-skip a resumed step).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../pipeline.js';
import { InMemoryEventBus } from '../event-bus.js';
import { InMemoryStepRegistry } from '../step-registry.js';
import type { PipelineEvent, Step } from '../types.js';

function buildRegistry(steps: Step<unknown, unknown>[]): InMemoryStepRegistry {
  const reg = new InMemoryStepRegistry();
  for (const s of steps) reg.register(s);
  return reg;
}

describe('Pipeline.run — Step.skipIf', () => {
  it('skips when predicate returns true and emits step:skipped with reason "skipIf"', async () => {
    const runs: string[] = [];
    const skipped: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:skipped', (e) => { skipped.push(e); });

    const registry = buildRegistry([
      { id: 'a', run: async () => { runs.push('a'); return 'a-out'; } },
      { id: 'b', skipIf: () => true, run: async () => { runs.push('b'); return 'b-out'; } },
      { id: 'c', run: async (ctx) => { runs.push(`c(${ctx.input})`); return 'c-out'; } },
    ]);

    const result = await new Pipeline({
      registry, bus, runId: 'r1', workspaceDir: '/tmp',
    }).run();

    assert.deepEqual(runs, ['a', 'c(a-out)'], 'b is skipped; c receives a-out unchanged');
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, ['a', 'b', 'c']);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].stepId, 'b');
    assert.deepEqual(skipped[0].payload, { reason: 'skipIf' });
  });

  it('runs the step when predicate returns false', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([
      { id: 'a', skipIf: () => false, run: async () => { runs.push('a'); return null; } },
    ]);
    await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
    }).run();
    assert.deepEqual(runs, ['a']);
  });

  it('supports async predicates', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([
      {
        id: 'a',
        skipIf: async () => Promise.resolve(true),
        run: async () => { runs.push('a'); return null; },
      },
    ]);
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
    }).run();
    assert.deepEqual(runs, []);
    assert.equal(result.status, 'success');
  });

  it('treats a throwing predicate as a terminal failure (does NOT silently run the step)', async () => {
    const runs: string[] = [];
    const failedEvents: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:failed', (e) => { failedEvents.push(e); });

    const registry = buildRegistry([
      { id: 'a', run: async () => { runs.push('a'); return null; } },
      {
        id: 'b',
        skipIf: () => { throw new Error('predicate exploded'); },
        run: async () => { runs.push('b'); return null; },
      },
      { id: 'c', run: async () => { runs.push('c'); return null; } },
    ]);

    const result = await new Pipeline({
      registry, bus, runId: 'r1', workspaceDir: '/tmp',
    }).run();

    assert.deepEqual(runs, ['a'], 'b never runs (predicate threw); c never reached (terminal failure)');
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 'b');
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0].stepId, 'b');
    assert.match(failedEvents[0].error?.message ?? '', /predicate exploded/);
  });

  it('predicate sees ctx.shared and ctx.input from the previous step', async () => {
    const seen: { shared: Record<string, unknown>; input: unknown }[] = [];
    const registry = buildRegistry([
      { id: 'a', run: async (ctx) => { (ctx.shared as Record<string, unknown>).planSeed = { id: 42 }; return 'a-out'; } },
      {
        id: 'b',
        skipIf: (ctx) => {
          seen.push({ shared: ctx.shared, input: ctx.input });
          return ctx.shared.planSeed != null;
        },
        run: async () => 'b-out',
      },
    ]);
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
    }).run();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].shared, { planSeed: { id: 42 } });
    assert.equal(seen[0].input, 'a-out');
    assert.equal(result.status, 'success');
  });

  it('completedSteps takes precedence over skipIf (skipIf is not called for already-completed steps)', async () => {
    let skipIfCalls = 0;
    const runs: string[] = [];
    const registry = buildRegistry([
      {
        id: 'a',
        skipIf: () => { skipIfCalls += 1; return false; },
        run: async () => { runs.push('a'); return null; },
      },
    ]);
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      completedSteps: ['a'],
    }).run();
    assert.equal(skipIfCalls, 0, 'skipIf is not consulted when step is already in completedSteps');
    assert.deepEqual(runs, []);
    assert.equal(result.status, 'success');
  });

  it('predicate cannot emit on the bus or signal abort — context has no bus / signal / emit', async () => {
    let observed: Record<string, unknown> = {};
    const registry = buildRegistry([
      {
        id: 'a',
        skipIf: (ctx) => {
          // Verify the skip context shape — no mutation seams.
          observed = ctx as unknown as Record<string, unknown>;
          return false;
        },
        run: async () => null,
      },
    ]);
    await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
    }).run();
    assert.equal(observed.bus, undefined);
    assert.equal(observed.emit, undefined);
    assert.equal(observed.signal, undefined);
    // Sanity: the read-only seams ARE present.
    assert.equal(typeof (observed.runId as string), 'string');
    assert.ok(observed.shared);
    assert.ok(observed.artifacts);
  });
});
