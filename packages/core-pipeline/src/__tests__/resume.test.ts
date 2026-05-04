/**
 * Phase 2 — Pipeline.run({resumeFromStep, completedSteps}) walker option.
 *
 * Coverage:
 *   - completedSteps emits step:skipped, does not invoke run()
 *   - resumeFromStep skips all prior steps in registry order
 *   - resumeFromStep + completedSteps union
 *   - resumeFromStep with unknown ID throws
 *   - skipped step is reflected in PipelineRunResult.completedSteps
 *   - input threading: first non-skipped step receives initialInput
 *     (not the prior skipped step's "output", since it never ran)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../pipeline.js';
import { InMemoryEventBus } from '../event-bus.js';
import { InMemoryStepRegistry } from '../step-registry.js';
import type { PipelineEvent, Step } from '../types.js';

function step(id: string, runs: string[]): Step<unknown, unknown> {
  return {
    id,
    parallelism: 'serial',
    run: async () => {
      runs.push(id);
      return id;
    },
  };
}

function buildRegistry(steps: Step<unknown, unknown>[]): InMemoryStepRegistry {
  const reg = new InMemoryStepRegistry();
  for (const s of steps) reg.register(s);
  return reg;
}

describe('Pipeline.run — completedSteps', () => {
  it('emits step:skipped for completed steps and does not invoke run()', async () => {
    const runs: string[] = [];
    const events: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:started', (e) => { events.push(e); });
    bus.on('step:completed', (e) => { events.push(e); });
    bus.on('step:skipped', (e) => { events.push(e); });

    const registry = buildRegistry([step('a', runs), step('b', runs), step('c', runs)]);
    const result = await new Pipeline({
      registry,
      bus,
      runId: 'r1',
      workspaceDir: '/tmp',
      completedSteps: ['a', 'b'],
    }).run();

    assert.deepEqual(runs, ['c'], 'only step c runs');
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, ['a', 'b', 'c']);
    const skipped = events.filter((e) => e.hook === 'step:skipped').map((e) => e.stepId);
    assert.deepEqual(skipped, ['a', 'b']);
  });

  it('skipped step:skipped payload carries reason: completed', async () => {
    const seen: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:skipped', (e) => { seen.push(e); });
    const runs: string[] = [];
    const registry = buildRegistry([step('a', runs)]);
    await new Pipeline({
      registry, bus, runId: 'r1', workspaceDir: '/tmp', completedSteps: ['a'],
    }).run();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].payload, { reason: 'completed' });
  });
});

describe('Pipeline.run — resumeFromStep', () => {
  it('skips all steps before the named step', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([
      step('clarify', runs), step('reqs', runs), step('specs', runs), step('build', runs),
    ]);
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      resumeFromStep: 'specs',
    }).run();
    assert.deepEqual(runs, ['specs', 'build']);
    assert.deepEqual(result.completedSteps, ['clarify', 'reqs', 'specs', 'build']);
  });

  it('throws when resumeFromStep is not in the registry', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([step('a', runs)]);
    await assert.rejects(
      () => new Pipeline({
        registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
        resumeFromStep: 'unknown',
      }).run(),
      /resumeFromStep "unknown" is not in the registry/,
    );
  });

  it('skipped step:skipped payload carries reason: resume', async () => {
    const seen: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:skipped', (e) => { seen.push(e); });
    const runs: string[] = [];
    const registry = buildRegistry([step('a', runs), step('b', runs)]);
    await new Pipeline({
      registry, bus, runId: 'r1', workspaceDir: '/tmp', resumeFromStep: 'b',
    }).run();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].payload, { reason: 'resume' });
  });
});

describe('Pipeline.run — resume + completedSteps union', () => {
  it('combines both skip sets', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([
      step('a', runs), step('b', runs), step('c', runs), step('d', runs),
    ]);
    // resumeFromStep=c skips a,b. completedSteps=['d'] also skips d.
    // Net: only c runs.
    const result = await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      resumeFromStep: 'c',
      completedSteps: ['d'],
    }).run();
    assert.deepEqual(runs, ['c']);
    assert.equal(result.status, 'success');
  });
});

describe('Pipeline.run — input threading with skips', () => {
  it('first non-skipped step receives initialInput', async () => {
    const seenInputs: unknown[] = [];
    const registry = new InMemoryStepRegistry();
    registry.register({
      id: 'a', parallelism: 'serial',
      run: async (ctx) => { seenInputs.push(['a', ctx.input]); return 'a-out'; },
    });
    registry.register({
      id: 'b', parallelism: 'serial',
      run: async (ctx) => { seenInputs.push(['b', ctx.input]); return 'b-out'; },
    });
    await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      initialInput: 'INITIAL',
      completedSteps: ['a'],
    }).run();
    // Only b runs; b receives initialInput (a never produced output).
    assert.deepEqual(seenInputs, [['b', 'INITIAL']]);
  });
});
