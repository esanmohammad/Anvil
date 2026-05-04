/**
 * pipeline-bus-subscriber — D10-preserving translator from core-pipeline
 * `PipelineEvent`s into the dashboard's `{type:'state', payload}` WS shape.
 *
 * Phase 2 of the dashboard consolidation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '@anvil/core-pipeline';
import type { PipelineEvent, StepHookPoint } from '@anvil/core-pipeline';
import {
  attachPipelineBusSubscriber,
  type PipelineStepDescriptor,
} from '../pipeline-bus-subscriber.js';
import type { ServerMessage, DashboardState } from '../dashboard-server.js';

/** Inline PipelineEvent builder so tests can stamp deterministic timestamps. */
function evt<P = unknown>(
  hook: StepHookPoint,
  runId: string,
  ts: string,
  extras: { stepId?: string; payload?: P; error?: PipelineEvent['error'] } = {},
): PipelineEvent<P> {
  return { hook, runId, ts, stepId: extras.stepId, payload: extras.payload, error: extras.error };
}

const STEPS: PipelineStepDescriptor[] = [
  { id: 'clarify', name: 'clarify', label: 'Understanding' },
  { id: 'plan', name: 'plan', label: 'Planning' },
  { id: 'build', name: 'build', label: 'Writing code', perRepo: true },
];

function setup() {
  const bus = new InMemoryEventBus();
  const broadcasts: ServerMessage[] = [];
  const handle = attachPipelineBusSubscriber(bus, {
    project: 'demo',
    feature: 'add login',
    featureSlug: 'add-login',
    model: 'sonnet',
    repoNames: ['api', 'web'],
    steps: STEPS,
    broadcast: (msg) => broadcasts.push(msg),
  });
  return { bus, broadcasts, handle };
}

function lastState(broadcasts: ServerMessage[]): DashboardState {
  const last = broadcasts[broadcasts.length - 1];
  assert.equal(last.type, 'state', 'most recent broadcast should be a state message');
  return last.payload as DashboardState;
}

describe('pipeline-bus-subscriber', () => {
  it('initial snapshot has no active pipeline', () => {
    const { handle } = setup();
    assert.equal(handle.snapshot().activePipeline, null);
  });

  it('pipeline:started seeds runId + status=running and broadcasts state', async () => {
    const { bus, broadcasts, handle } = setup();
    await bus.emit(evt('pipeline:started', 'run-abc', '2026-04-29T00:00:00.000Z'));
    assert.equal(handle.broadcastCount, 1);
    const state = lastState(broadcasts);
    assert.ok(state.activePipeline);
    assert.equal(state.activePipeline.runId, 'run-abc');
    assert.equal(state.activePipeline.status, 'running');
    assert.equal(state.activePipeline.stages.length, STEPS.length);
    assert.equal(state.activePipeline.stages.every((s) => s.status === 'pending'), true);
  });

  it('step:started flips matching stage to running and updates currentStage', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(evt('step:started', 'run-1', 't1', { stepId: 'plan' }));
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.currentStage, 1);
    assert.equal(state.activePipeline!.stages[1].status, 'running');
    assert.equal(state.activePipeline!.stages[1].startedAt, 't1');
  });

  it('step:completed accumulates costUsd from payload onto the stage and total', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(
      evt('step:completed', 'run-1', 't2', { stepId: 'plan', payload: { costUsd: 0.42 } }),
    );
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.stages[1].status, 'completed');
    assert.equal(state.activePipeline!.stages[1].completedAt, 't2');
    assert.equal(state.activePipeline!.stages[1].cost, 0.42);
    assert.equal(state.activePipeline!.cost.estimatedCost, 0.42);
  });

  it('step:completed reads costUsd from nested payload.data shape', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(
      evt('step:completed', 'run-1', 't2', { stepId: 'build', payload: { data: { costUsd: 1.5 } } }),
    );
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.stages[2].cost, 1.5);
    assert.equal(state.activePipeline!.cost.estimatedCost, 1.5);
  });

  it('step:failed marks the stage failed with error.message', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(
      evt('step:failed', 'run-1', 't3', {
        stepId: 'build',
        error: { message: 'compilation failed' },
      }),
    );
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.stages[2].status, 'failed');
    assert.equal(state.activePipeline!.stages[2].error, 'compilation failed');
  });

  it('pipeline:completed sets top-level status', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(evt('pipeline:completed', 'run-1', 't9'));
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.status, 'completed');
  });

  it('pipeline:failed sets top-level status', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(evt('pipeline:failed', 'run-1', 't9'));
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.status, 'failed');
  });

  it('events for unknown stepId leave the snapshot stable but still broadcast', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    const beforeCount = broadcasts.length;
    await bus.emit(evt('step:started', 'run-1', 't1', { stepId: 'unknown-step' }));
    assert.equal(broadcasts.length, beforeCount + 1);
    const state = lastState(broadcasts);
    assert.equal(state.activePipeline!.stages.every((s) => s.status === 'pending'), true);
  });

  it('unsubscribe stops further broadcasts', async () => {
    const { bus, broadcasts, handle } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    handle.unsubscribe();
    await bus.emit(evt('step:started', 'run-1', 't1', { stepId: 'plan' }));
    assert.equal(broadcasts.length, 1);
  });

  it('preserves WS shape — every broadcast is { type: "state", payload: DashboardState }', async () => {
    const { bus, broadcasts } = setup();
    await bus.emit(evt('pipeline:started', 'run-1', 't0'));
    await bus.emit(evt('step:started', 'run-1', 't1', { stepId: 'clarify' }));
    await bus.emit(
      evt('step:completed', 'run-1', 't2', { stepId: 'clarify', payload: { costUsd: 0.05 } }),
    );

    for (const msg of broadcasts) {
      assert.equal(msg.type, 'state');
      const payload = msg.payload as DashboardState;
      assert.ok(typeof payload.lastUpdated === 'string');
      assert.ok(payload.activePipeline);
      assert.equal(typeof payload.activePipeline.runId, 'string');
      assert.ok(Array.isArray(payload.activePipeline.stages));
    }
  });
});
