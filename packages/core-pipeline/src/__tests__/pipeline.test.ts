/**
 * Phase 3 — Pipeline runner walker tests.
 *
 * Coverage:
 *   - empty registry: pipeline:started → pipeline:completed (no step events)
 *   - single step: pipeline:started → step:started → step:completed → pipeline:completed
 *   - sequence: each step's input is the previous step's output
 *   - failure-mid: emits step:failed + pipeline:failed; subsequent steps skipped
 *   - artifact:emitted fires when ctx.emit() is called
 *   - abort signal: pipeline:aborted-equivalent (status='aborted') after failed/skipped step boundary
 *   - PipelineRunResult shape: completedSteps reflects success path
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
    'artifact:emitted',
  ];
  for (const h of hooks) {
    bus.on(h, (e) => {
      into.push(e);
    });
  }
}

describe('Pipeline walker (Phase 3)', () => {
  it('empty registry: pipeline:started → pipeline:completed only', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const events: PipelineEvent[] = [];
    recordEvents(bus, events);
    const result = await new Pipeline({ bus, registry: reg, runId: 'r1', workspaceDir: '/tmp' }).run();
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, []);
    assert.deepEqual(events.map((e) => e.hook), ['pipeline:started', 'pipeline:completed']);
  });

  it('single step: full lifecycle in order', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const events: PipelineEvent[] = [];
    recordEvents(bus, events);
    reg.register({
      id: 'clarify',
      run: async (ctx) => {
        ctx.emit('CLARIFICATION.md', '# clarification');
        return 'out-from-clarify';
      },
    } as Step<unknown, unknown>);
    const p = new Pipeline({ bus, registry: reg, runId: 'r2', workspaceDir: '/tmp' });
    const result = await p.run();
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, ['clarify']);
    assert.deepEqual(events.map((e) => e.hook), [
      'pipeline:started',
      'step:started',
      'artifact:emitted',
      'step:completed',
      'pipeline:completed',
    ]);
    assert.equal(p.getArtifacts().read('CLARIFICATION.md'), '# clarification');
  });

  it('sequence: each step receives prior step output as ctx.input', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const seen: unknown[] = [];
    reg.register({
      id: 'a',
      run: async (ctx) => {
        seen.push(ctx.input);
        return { from: 'a' };
      },
    } as Step<unknown, unknown>);
    reg.register({
      id: 'b',
      run: async (ctx) => {
        seen.push(ctx.input);
        return { from: 'b' };
      },
    } as Step<unknown, unknown>);
    const p = new Pipeline({
      bus,
      registry: reg,
      runId: 'r3',
      workspaceDir: '/tmp',
      initialInput: { seed: true },
    });
    const result = await p.run();
    assert.equal(result.status, 'success');
    assert.deepEqual(result.completedSteps, ['a', 'b']);
    assert.deepEqual(seen, [{ seed: true }, { from: 'a' }]);
  });

  it('failure-mid: emits step:failed + pipeline:failed; subsequent step skipped', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const events: PipelineEvent[] = [];
    recordEvents(bus, events);
    let bRan = false;
    reg.register({
      id: 'a',
      run: async () => {
        throw new Error('a-broke');
      },
    } as Step<unknown, unknown>);
    reg.register({
      id: 'b',
      run: async () => {
        bRan = true;
      },
    } as Step<unknown, unknown>);
    const result = await new Pipeline({ bus, registry: reg, runId: 'r4', workspaceDir: '/tmp' }).run();
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 'a');
    assert.equal(bRan, false);
    assert.deepEqual(events.map((e) => e.hook), [
      'pipeline:started',
      'step:started',
      'step:failed',
      'pipeline:failed',
    ]);
    const failedEvent = events.find((e) => e.hook === 'pipeline:failed')!;
    assert.match(failedEvent.error?.message ?? '', /a-broke/);
  });

  it('abort signal: status = aborted; remaining steps skipped', async () => {
    const bus = new InMemoryEventBus();
    const reg = new InMemoryStepRegistry();
    const ac = new AbortController();
    let bRan = false;
    reg.register({
      id: 'a',
      run: async () => {
        ac.abort();
      },
    } as Step<unknown, unknown>);
    reg.register({
      id: 'b',
      run: async () => {
        bRan = true;
      },
    } as Step<unknown, unknown>);
    const result = await new Pipeline({
      bus,
      registry: reg,
      runId: 'r5',
      workspaceDir: '/tmp',
      signal: ac.signal,
    }).run();
    assert.equal(result.status, 'aborted');
    assert.deepEqual(result.completedSteps, ['a']);
    assert.equal(bRan, false);
  });
});
