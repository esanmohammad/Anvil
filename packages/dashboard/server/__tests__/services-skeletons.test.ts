/**
 * Smoke tests for the Phase 2 service skeletons.
 *
 * Verifies:
 *   - Each service can emit + listen with typed payloads.
 *   - `createServices()` returns a bundle where every service is
 *     a fresh independent Emittery (no shared listeners).
 *   - `onAny` captures every emission — this is the seam the
 *     service-bridge will use in Phase 3 to fan events into the
 *     EventReplay buffer + (Phase 4) socket.io rooms.
 *
 * Pure unit tests — no harness boot, no WS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createServices,
  RunService,
  AgentService,
  PlanService,
} from '../services/index.js';

test('services: createServices returns independent instances', () => {
  const a = createServices();
  const b = createServices();
  assert.notEqual(a.runs, b.runs, 'separate RunService instances');
  assert.notEqual(a.agents, b.agents);
});

test('services.runs: typed emit + on roundtrip', async () => {
  const runs = new RunService();
  const captured: Array<{ runId: string; status: string }> = [];
  runs.on('run.state-changed', (payload) => {
    captured.push({ runId: payload.runId, status: payload.status });
  });

  await runs.emit('run.state-changed', {
    runId: 'r1',
    status: 'running',
  });
  await runs.emit('run.state-changed', {
    runId: 'r1',
    status: 'completed',
  });

  assert.deepEqual(captured, [
    { runId: 'r1', status: 'running' },
    { runId: 'r1', status: 'completed' },
  ]);
});

test('services.agents: onAny captures every kind in order', async () => {
  const agents = new AgentService();
  const captured: Array<{ kind: string; agentId: string }> = [];
  agents.onAny((kind, payload) => {
    const id = (payload as { id?: string; agentId?: string }).id
      ?? (payload as { agentId?: string }).agentId
      ?? '';
    captured.push({ kind, agentId: id });
  });

  await agents.emit('agent.spawned', { id: 'a1' });
  await agents.emit('agent.output', { entries: [], runId: 'r1' });
  await agents.emit('agent.done', { agentId: 'a1', agent: {} });

  assert.deepEqual(
    captured.map((c) => c.kind),
    ['agent.spawned', 'agent.output', 'agent.done'],
  );
});

test('services: separate services do not share listeners', async () => {
  const services = createServices();
  let runHits = 0;
  let planHits = 0;
  services.runs.onAny(() => { runHits++; });
  services.plans.onAny(() => { planHits++; });

  await services.runs.emit('run.stopped', { runId: 'r1' });
  await services.plans.emit('plan.created', { plan: {}, validation: {} });

  assert.equal(runHits, 1, 'runs listener fired once');
  assert.equal(planHits, 1, 'plans listener fired once');
});

test('services.plans: typed payloads (compile-time check via narrow access)', async () => {
  const plans = new PlanService();
  let observed: { planSlug: string; commentId: string; ok: boolean } | null = null;
  plans.on('plan.comment-resolved', (payload) => {
    observed = payload;
  });

  await plans.emit('plan.comment-resolved', {
    planSlug: 'add-button',
    commentId: 'c-123',
    ok: true,
  });

  assert.deepEqual(observed, {
    planSlug: 'add-button',
    commentId: 'c-123',
    ok: true,
  });
});
