/**
 * Phase E.3 — `attachDashboardStateRollupHook` (ADR §4.5).
 *
 * Coverage:
 *   - pipeline:* events update state.status
 *   - step:started/completed/failed/skipped update per-stage status
 *   - stage:repo-progress upserts repos and tracks cost / error
 *   - stage:cost-update sets totalCost and increments stage cost
 *   - stage:fix-attempt updates stage.fixAttempt
 *   - reviewer:note updates stage.reviewerNote
 *   - broadcast() debounce coalesces multiple mutations
 *   - listener errors land on lastError, never throw
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../event-bus.js';
import {
  attachDashboardStateRollupHook,
  type DashboardRollupState,
} from '../hooks/dashboard-state-rollup.hook.js';

const seedState = (): DashboardRollupState => ({
  runId: '',
  status: 'running',
  currentStage: 0,
  totalCost: 0,
  stages: [
    { name: 'clarify', status: 'pending', startedAt: null, completedAt: null, cost: 0, artifact: '', error: null, repos: [] },
    { name: 'specs', status: 'pending', startedAt: null, completedAt: null, cost: 0, artifact: '', error: null, repos: [] },
    { name: 'build', status: 'pending', startedAt: null, completedAt: null, cost: 0, artifact: '', error: null, repos: [] },
    { name: 'validate', status: 'pending', startedAt: null, completedAt: null, cost: 0, artifact: '', error: null, repos: [] },
  ],
});

const installFakeTimers = (): {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  flush: () => void;
} => {
  let pending: { fn: () => void } | undefined;
  return {
    setTimer: (fn) => {
      pending = { fn };
      return pending;
    },
    clearTimer: (h) => {
      if (pending === h) pending = undefined;
    },
    flush: () => {
      const p = pending;
      pending = undefined;
      p?.fn();
    },
  };
};

describe('attachDashboardStateRollupHook (Phase E.3)', () => {
  it('pipeline:started/completed mutates state.status and runId', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    let broadcasts = 0;
    const t = installFakeTimers();
    const handle = attachDashboardStateRollupHook(bus, {
      state,
      broadcast: () => { broadcasts++; },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    await bus.emit({ hook: 'pipeline:started', runId: 'run-77', ts: '2026-04-29T00:00:00.000Z' });
    t.flush();
    assert.equal(state.runId, 'run-77');
    assert.equal(state.status, 'running');
    assert.equal(broadcasts, 1);

    await bus.emit({ hook: 'pipeline:completed', runId: 'run-77', ts: '2026-04-29T00:01:00.000Z' });
    t.flush();
    assert.equal(state.status, 'completed');
    assert.equal(broadcasts, 2);
    handle.unsubscribe();
  });

  it('step:started/completed/failed/skipped update per-stage status + currentStage', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    attachDashboardStateRollupHook(bus, { state, broadcast: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });

    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'specs', ts: '2026-04-29T00:00:01.000Z' });
    assert.equal(state.stages[1].status, 'running');
    assert.equal(state.stages[1].startedAt, '2026-04-29T00:00:01.000Z');
    assert.equal(state.currentStage, 1);

    await bus.emit({ hook: 'step:completed', runId: 'r1', stepId: 'specs', ts: '2026-04-29T00:00:05.000Z' });
    assert.equal(state.stages[1].status, 'completed');
    assert.equal(state.stages[1].completedAt, '2026-04-29T00:00:05.000Z');

    await bus.emit({
      hook: 'step:failed',
      runId: 'r1',
      stepId: 'build',
      ts: '2026-04-29T00:00:09.000Z',
      error: { message: 'agent crashed' },
    });
    assert.equal(state.stages[2].status, 'failed');
    assert.equal(state.stages[2].error, 'agent crashed');

    await bus.emit({ hook: 'step:skipped', runId: 'r1', stepId: 'validate', ts: '2026-04-29T00:00:10.000Z' });
    assert.equal(state.stages[3].status, 'skipped');
    assert.equal(state.stages[3].completedAt, '2026-04-29T00:00:10.000Z');
  });

  it('stage:repo-progress upserts repos and tracks cost + error', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    attachDashboardStateRollupHook(bus, { state, broadcast: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });

    await bus.emit({
      hook: 'stage:repo-progress',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'specs', stageIndex: 1, repoName: 'web', status: 'running' },
    });
    assert.equal(state.stages[1].repos.length, 1);
    assert.equal(state.stages[1].repos[0].repoName, 'web');
    assert.equal(state.stages[1].repos[0].status, 'running');

    await bus.emit({
      hook: 'stage:repo-progress',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'specs', stageIndex: 1, repoName: 'web', status: 'completed', costUsd: 0.014 },
    });
    assert.equal(state.stages[1].repos[0].status, 'completed');
    assert.equal(state.stages[1].repos[0].cost, 0.014);

    await bus.emit({
      hook: 'stage:repo-progress',
      runId: 'r1',
      ts: '2026-04-29T00:00:02.000Z',
      payload: { stageId: 'specs', stageIndex: 1, repoName: 'api', status: 'failed', error: { message: 'timeout' } },
    });
    assert.equal(state.stages[1].repos.length, 2);
    assert.equal(state.stages[1].repos[1].error, 'timeout');
  });

  it('stage:cost-update sets totalCost and increments stage cost', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    attachDashboardStateRollupHook(bus, { state, broadcast: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });

    await bus.emit({
      hook: 'stage:cost-update',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'build', stageIndex: 2, deltaUsd: 0.010, totalUsd: 0.010 },
    });
    assert.equal(state.totalCost, 0.010);
    assert.equal(state.stages[2].cost, 0.010);

    await bus.emit({
      hook: 'stage:cost-update',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'build', stageIndex: 2, deltaUsd: 0.005, totalUsd: 0.015 },
    });
    assert.equal(state.totalCost, 0.015);
    assert.equal(Math.round(state.stages[2].cost * 1000) / 1000, 0.015);
  });

  it('stage:fix-attempt updates stage.fixAttempt', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    attachDashboardStateRollupHook(bus, { state, broadcast: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });

    await bus.emit({
      hook: 'stage:fix-attempt',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'validate', stageIndex: 3, attempt: 2, maxAttempts: 3, phase: 'fix' },
    });
    assert.deepEqual(state.stages[3].fixAttempt, { attempt: 2, maxAttempts: 3, phase: 'fix' });
  });

  it('reviewer:note updates stage.reviewerNote', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    attachDashboardStateRollupHook(bus, { state, broadcast: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });

    await bus.emit({
      hook: 'reviewer:note',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.000Z',
      payload: { stageId: 'specs', stageIndex: 1, note: 'Tighten auth scopes', source: 'pause-resolution' },
    });
    assert.deepEqual(state.stages[1].reviewerNote, {
      note: 'Tighten auth scopes',
      source: 'pause-resolution',
    });
  });

  it('broadcast debounces — multiple mutations coalesce into one broadcast', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    let broadcasts = 0;
    const t = installFakeTimers();
    attachDashboardStateRollupHook(bus, {
      state,
      broadcast: () => { broadcasts++; },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'build', ts: '2026-04-29T00:00:00.000Z' });
    await bus.emit({
      hook: 'stage:cost-update',
      runId: 'r1',
      ts: '2026-04-29T00:00:00.500Z',
      payload: { stageId: 'build', stageIndex: 2, deltaUsd: 0.01, totalUsd: 0.01 },
    });
    await bus.emit({
      hook: 'stage:repo-progress',
      runId: 'r1',
      ts: '2026-04-29T00:00:01.000Z',
      payload: { stageId: 'build', stageIndex: 2, repoName: 'web', status: 'running' },
    });
    assert.equal(broadcasts, 0, 'pending — debounced');
    t.flush();
    assert.equal(broadcasts, 1, 'three mutations coalesced to one broadcast');
  });

  it('flush() forces pending broadcast immediately', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    let broadcasts = 0;
    const t = installFakeTimers();
    const handle = attachDashboardStateRollupHook(bus, {
      state,
      broadcast: () => { broadcasts++; },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'specs', ts: '2026-04-29T00:00:00.000Z' });
    assert.equal(broadcasts, 0);
    handle.flush();
    assert.equal(broadcasts, 1);
  });

  it('broadcast errors land on lastError without throwing', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    const handle = attachDashboardStateRollupHook(bus, {
      state,
      broadcast: () => { throw new Error('ws closed'); },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });

    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'build', ts: '2026-04-29T00:00:00.000Z' });
    t.flush();
    assert.ok(handle.lastError instanceof Error);
    assert.match(handle.lastError!.message, /ws closed/);
  });

  it('unsubscribe stops further mutations', async () => {
    const bus = new InMemoryEventBus();
    const state = seedState();
    const t = installFakeTimers();
    const handle = attachDashboardStateRollupHook(bus, { state, broadcast: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });

    handle.unsubscribe();
    await bus.emit({ hook: 'step:started', runId: 'r1', stepId: 'build', ts: '2026-04-29T00:00:00.000Z' });
    assert.equal(state.stages[2].status, 'pending');
  });
});
