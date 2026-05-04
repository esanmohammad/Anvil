/**
 * Phase 1 — scaffold smoke tests.
 *
 * Validates package shape, type round-trips, EventBus emit/on, StepRegistry
 * register/insertBefore/remove. Pipeline.run is stubbed; asserts the stub
 * throws so Phase 3 has a clear "wire the walker" entry point.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  VERSION,
  type PipelineEvent,
  type Step,
} from '../index.js';

describe('scaffold (Phase 1)', () => {
  it('exports VERSION 0.0.1 and the public surface', () => {
    assert.equal(VERSION, '0.0.1');
    assert.equal(typeof InMemoryEventBus, 'function');
    assert.equal(typeof InMemoryStepRegistry, 'function');
    assert.equal(typeof Pipeline, 'function');
  });

  it('EventBus delivers emitted events to subscribers (await)', async () => {
    const bus = new InMemoryEventBus();
    const seen: PipelineEvent[] = [];
    const off = bus.on('step:started', (e) => {
      seen.push(e);
    });
    await bus.emit({
      hook: 'step:started',
      runId: 'r1',
      stepId: 'clarify',
      ts: new Date().toISOString(),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stepId, 'clarify');
    off();
    await bus.emit({
      hook: 'step:started',
      runId: 'r1',
      stepId: 'requirements',
      ts: new Date().toISOString(),
    });
    assert.equal(seen.length, 1, 'unsubscribe handle silenced the listener');
  });

  it('StepRegistry: register / insertBefore / insertAfter / remove preserve order', () => {
    const reg = new InMemoryStepRegistry();
    const make = (id: string): Step<unknown, unknown> => ({
      id,
      run: async () => undefined,
    });
    reg.register(make('a'));
    reg.register(make('c'));
    reg.insertBefore('c', make('b'));
    reg.insertAfter('c', make('d'));
    assert.deepEqual(reg.steps().map((s) => s.id), ['a', 'b', 'c', 'd']);
    reg.remove('b');
    assert.deepEqual(reg.steps().map((s) => s.id), ['a', 'c', 'd']);
  });

  it('Pipeline.run() runs an empty registry to clean success', async () => {
    const reg = new InMemoryStepRegistry();
    const bus = new InMemoryEventBus();
    const p = new Pipeline({
      registry: reg,
      bus,
      runId: 'r1',
      workspaceDir: '/tmp/ws',
    });
    const result = await p.run();
    assert.equal(result.status, 'success');
    assert.equal(result.runId, 'r1');
    assert.deepEqual(result.completedSteps, []);
  });
});
