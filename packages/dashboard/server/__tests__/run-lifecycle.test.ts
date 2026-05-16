/**
 * Run-lifecycle scenarios (Group 1 of WS-EXTRACTION-PLAN).
 *
 * Pins the wire-level contract for quick-action runs (run-spike / run-review):
 *   - 1.1-spike  run-spike start → activity × N → done emits the expected
 *                run-lifecycle sequence (active-runs registration, agent
 *                spawn echo, per-activity broadcasts, completion + cleanup).
 *   - 1.3-spike  run-spike start → stop-run mid-flight emits run-stopped
 *                + active-runs flip BEFORE the kill chain completes.
 *
 * Full pipeline scenarios (1.1 build happy path, 1.2 fail-in-stage, 1.4
 * pause/resume, 1.6 cost breach, 1.7 rollback, 1.8 reconnect-during-run)
 * land in a follow-up sub-PR that adds a PipelineRunner-factory deps seam.
 * Quick actions exercise the same run-lifecycle plumbing without the
 * heavyweight runner construction.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';
import { stripVolatile } from './_harness/strip-volatile.js';
import { matchSnapshot } from './_harness/snapshot-store.js';
import type { WireMessage } from './_harness/dashboard-client.js';

after(() => forceExitAfterTests());

test('1.1-spike run-spike start → activity → done lifecycle', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  // Kick off — spawnQuickAction is async-ish but agent spawn happens
  // synchronously inside it. We immediately get a salvo of broadcasts:
  // two `agent-output` (kb + workspace seed entries), `active-runs`, and
  // `agent-spawned` (with runId).
  client.send({ action: 'run-spike', project: 'demo', feature: 'investigate-thing' });

  // Wait for agent-spawned — that's where we learn the agentId.
  const spawned = await client.waitFor('agent-spawned', 5000);
  const agentId = (spawned.payload as { id: string }).id;
  const runId = (spawned.payload as { runId: string }).runId;
  assert.ok(agentId, 'agent-spawned must include agent id');
  assert.ok(runId, 'agent-spawned must include runId');

  // Script the agent. Each emitActivity → broadcasts an agent-output entry
  // tagged with runId (lookup via agentToRunId map in the server).
  harness.agentManager.emitActivity(agentId, {
    kind: 'text',
    summary: 'Starting investigation',
    content: 'Starting investigation',
  });
  harness.agentManager.emitActivity(agentId, {
    kind: 'tool_use',
    summary: 'grep: TODO',
    tool: 'grep',
    content: 'searching for TODO markers',
  });

  // Capture from now until the run completes (active-runs shrinks back to
  // empty after the agent-done handler runs broadcastActiveRuns()).
  const lifecyclePromise = client.collect({
    until: (m) =>
      m.type === 'active-runs' &&
      Array.isArray((m.payload as unknown[])) &&
      ((m.payload as unknown[]).length === 0 ||
        !((m.payload as Array<{ id: string }>).some((r) => r.id === runId))),
    timeoutMs: 5000,
  });
  harness.agentManager.emitDone(agentId, 'done', { finalAnswer: 'investigation complete' });
  const lifecycle = await lifecyclePromise;

  // Pin the lifecycle event sequence (types + runId presence + run statuses).
  matchSnapshot(
    lifecycle.map((m) => normaliseLifecycle(m, agentId, runId)),
    { name: 'run-lifecycle-1.1-spike-happy-path' },
  );
});

test('1.3-spike run-spike → stop-run mid-flight flips status and broadcasts run-stopped', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'run-spike', project: 'demo', feature: 'will-be-stopped' });
  const spawned = await client.waitFor('agent-spawned', 5000);
  const runId = (spawned.payload as { runId: string }).runId;
  const agentId = (spawned.payload as { id: string }).id;

  // Don't emit any activity — call stop-run immediately. The server's stop
  // handler at dashboard-server.ts:2120 must:
  //   1. Flip run.status = 'failed'.
  //   2. broadcast({ type: 'run-stopped', payload: { runId } })  ← FIRST
  //   3. broadcastActiveRuns()                                    ← THEN
  //   4. Kill the agent (which fires agent-done via FakeAgentManager).
  // The "broadcast first, kill after" ordering is the regression we hoisted
  // around earlier — this scenario locks it down.
  const stopSequencePromise = client.collect({
    until: (m) => m.type === 'agent-done',
    timeoutMs: 5000,
  });
  client.send({ action: 'stop-run', runId });
  const stopSequence = await stopSequencePromise;

  // run-stopped MUST appear before agent-done in the sequence.
  const stoppedIdx = stopSequence.findIndex((m) => m.type === 'run-stopped');
  const doneIdx = stopSequence.findIndex((m) => m.type === 'agent-done');
  assert.ok(stoppedIdx >= 0, 'run-stopped must be broadcast');
  assert.ok(doneIdx > stoppedIdx, 'agent-done must follow run-stopped (broadcast-first ordering)');

  assert.ok(harness.agentManager.wasKilled(agentId), 'agent was killed by stop-run handler');

  matchSnapshot(
    stopSequence.map((m) => normaliseLifecycle(m, agentId, runId)),
    { name: 'run-lifecycle-1.3-spike-stop-mid-flight' },
  );
});

/**
 * Reduce a wire message to a snapshot-friendly form for lifecycle assertions.
 * Pins: ordering, event types, run status presence, run-id correlation,
 * agent-spawned shape — without locking in payload internals that drift
 * naturally (timestamps, full activity bodies, model names from env, …).
 */
function normaliseLifecycle(
  m: WireMessage,
  agentId: string,
  runId: string,
): unknown {
  const stripped = stripVolatile(m) as { type: string; payload: any };

  if (stripped.type === 'active-runs') {
    const runs = stripped.payload as Array<{ id: string; status: string; type: string }>;
    return {
      type: stripped.type,
      runCount: runs.length,
      runStatuses: runs.map((r) => ({ status: r.status, type: r.type, isOurRun: r.id === runId })),
    };
  }
  if (stripped.type === 'agent-spawned') {
    const p = stripped.payload as { id: string; runId?: string };
    return {
      type: stripped.type,
      idMatchesAgent: p.id === agentId,
      hasRunId: p.runId === runId,
    };
  }
  if (stripped.type === 'agent-output') {
    const p = stripped.payload as { entries: Array<{ kind: string; tool?: string }>; runId?: string };
    return {
      type: stripped.type,
      entries: p.entries.map((e) => ({ kind: e.kind, tool: e.tool ?? null })),
      isOurRun: p.runId === runId,
    };
  }
  if (stripped.type === 'agent-done') {
    const p = stripped.payload as { agentId: string; agent: { status: string } };
    return {
      type: stripped.type,
      agentStatus: p.agent.status,
      idMatchesAgent: p.agentId === agentId,
    };
  }
  if (stripped.type === 'run-stopped') {
    const p = stripped.payload as { runId: string };
    return {
      type: stripped.type,
      isOurRun: p.runId === runId,
    };
  }
  if (stripped.type === 'runs') {
    // The full runs list shape isn't part of this scenario's contract —
    // just record that a persistence-snapshot broadcast happened.
    return { type: stripped.type };
  }
  return { type: stripped.type };
}
