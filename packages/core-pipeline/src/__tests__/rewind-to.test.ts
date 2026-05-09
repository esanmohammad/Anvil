/**
 * Phase A2 — Pipeline.run({ rewindTo }) reviewer-rewind primitive.
 *
 * Coverage:
 *   - rewindTo skips steps BEFORE the target (reason 'rewind') and
 *     RE-RUNS the target + everything after, even if priorCompletedSteps
 *     said they were done.
 *   - rewindTo + resumeFromStep both set throws.
 *   - rewindTo unknown id throws.
 *   - prefix steps not in priorCompletedSteps still emit 'rewind'
 *     (the rewind reason takes precedence over default 'resume').
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
    run: async () => { runs.push(id); return id; },
  };
}

function buildRegistry(steps: Step<unknown, unknown>[]): InMemoryStepRegistry {
  const reg = new InMemoryStepRegistry();
  for (const s of steps) reg.register(s);
  return reg;
}

describe('Pipeline.run — rewindTo', () => {
  it('skips prefix with reason "rewind" and re-runs target + suffix', async () => {
    const runs: string[] = [];
    const skipped: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:skipped', (e) => { skipped.push(e); });

    const registry = buildRegistry([
      step('clarify', runs), step('reqs', runs),
      step('specs', runs), step('tasks', runs), step('build', runs),
    ]);

    const result = await new Pipeline({
      registry, bus, runId: 'r1', workspaceDir: '/tmp',
      completedSteps: ['clarify', 'reqs', 'specs', 'tasks', 'build'],
      rewindTo: 'specs',
    }).run();

    // clarify, reqs skipped — specs, tasks, build re-run.
    assert.deepEqual(runs, ['specs', 'tasks', 'build']);
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, ['clarify', 'reqs', 'specs', 'tasks', 'build']);

    const reasons = skipped.map((e) => ({ id: e.stepId, reason: (e.payload as { reason: string }).reason }));
    assert.deepEqual(reasons, [
      { id: 'clarify', reason: 'rewind' },
      { id: 'reqs', reason: 'rewind' },
    ]);
  });

  it('emits "rewind" for prefix steps even when they were not in priorCompletedSteps', async () => {
    // Caller passes rewindTo='c' but no completedSteps — every step
    // before 'c' still skips with reason 'rewind'.
    const runs: string[] = [];
    const skipped: PipelineEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.on('step:skipped', (e) => { skipped.push(e); });
    const registry = buildRegistry([
      step('a', runs), step('b', runs), step('c', runs), step('d', runs),
    ]);
    await new Pipeline({
      registry, bus, runId: 'r1', workspaceDir: '/tmp', rewindTo: 'c',
    }).run();
    assert.deepEqual(runs, ['c', 'd']);
    const reasons = skipped.map((e) => (e.payload as { reason: string }).reason);
    assert.deepEqual(reasons, ['rewind', 'rewind']);
  });

  it('throws when both rewindTo and resumeFromStep are set', async () => {
    const registry = buildRegistry([step('a', []), step('b', [])]);
    await assert.rejects(
      () => new Pipeline({
        registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
        rewindTo: 'a', resumeFromStep: 'b',
      }).run(),
      /rewindTo and resumeFromStep are mutually exclusive/,
    );
  });

  it('throws when rewindTo is not in the registry', async () => {
    const registry = buildRegistry([step('a', [])]);
    await assert.rejects(
      () => new Pipeline({
        registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
        rewindTo: 'unknown',
      }).run(),
      /rewindTo "unknown" is not in the registry/,
    );
  });

  it('runs only the target when rewindTo is the last step', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([step('a', runs), step('b', runs), step('c', runs)]);
    await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      completedSteps: ['a', 'b', 'c'],
      rewindTo: 'c',
    }).run();
    assert.deepEqual(runs, ['c']);
  });

  it('rewindTo at the first step re-runs everything', async () => {
    const runs: string[] = [];
    const registry = buildRegistry([step('a', runs), step('b', runs)]);
    await new Pipeline({
      registry, bus: new InMemoryEventBus(), runId: 'r1', workspaceDir: '/tmp',
      completedSteps: ['a', 'b'],
      rewindTo: 'a',
    }).run();
    assert.deepEqual(runs, ['a', 'b']);
  });
});
