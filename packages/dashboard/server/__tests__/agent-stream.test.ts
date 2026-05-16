/**
 * Agent-stream scenarios (Group 2 of WS-EXTRACTION-PLAN).
 *
 * Pins the wire-level shape of:
 *   - 2.1 spawn → activity × N → done
 *   - 2.2 spawn → kill mid-stream
 *
 * These are the "fundamental smoke" tests for the FakeAgentManager
 * dependency-injection seam. If they're green, all the higher-level
 * run-lifecycle scenarios (Group 1) inherit a working agent fake.
 *
 * Each test owns its own boot so spawn ids don't leak across scenarios.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { bootDashboard, forceExitAfterTests } from './_harness/boot.js';
import { stripVolatile } from './_harness/strip-volatile.js';
import { matchSnapshot } from './_harness/snapshot-store.js';
import type { WireMessage } from './_harness/dashboard-client.js';

after(() => forceExitAfterTests());

test('2.1 spawn → activity × 3 → done emits expected wire sequence', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());

  // Drain init so it doesn't appear in the snapshot.
  await client.waitFor('init', 5000);

  // Kick off a spawn — the handler at dashboard-server.ts:2079 will ask the
  // injected FakeAgentManager for a new agent and send `agent-spawned` back
  // on this client (NOT broadcast).
  client.send({ action: 'spawn-agent', project: 'demo', feature: 'add-button' });
  const spawned = await client.waitFor('agent-spawned', 5000);
  const agentId = (spawned.payload as { id: string }).id;
  assert.match(agentId, /^agent-fake-/, 'spawn returns fake-prefixed agent id');

  // Script the agent's lifecycle. EventEmitter.emit() runs subscribers
  // synchronously, so the broadcast() calls happen inline and the client's
  // buffered ws.send messages start landing on the next event-loop tick.
  harness.agentManager.emitActivity(agentId, {
    kind: 'text',
    summary: 'hello world',
    content: 'hello world (full)',
  });
  harness.agentManager.emitActivity(agentId, {
    kind: 'tool_use',
    summary: 'read_file: README.md',
    tool: 'read_file',
    content: 'reading README.md…',
  });
  harness.agentManager.emitActivity(agentId, {
    kind: 'thinking',
    summary: 'planning the approach',
    content: 'thinking deeply…',
  });

  // Start collecting BEFORE emitting done — the predicate matches on
  // `agent-done`, which will land last.
  const eventsPromise = client.collect({
    until: (m) => m.type === 'agent-done',
    timeoutMs: 5000,
  });
  harness.agentManager.emitDone(agentId, 'done', { finalAnswer: 'done.' });
  const collected = await eventsPromise;

  const summarised = collected.map((m: WireMessage) => normaliseEvent(m, agentId));
  matchSnapshot(summarised, { name: 'agent-stream-2.1-spawn-activities-done' });
});

test('2.2 spawn → kill mid-stream emits killed status', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'spawn-agent', project: 'demo', feature: 'kill-me' });
  const spawned = await client.waitFor('agent-spawned', 5000);
  const agentId = (spawned.payload as { id: string }).id;

  // Drive ONE activity, then kill.
  harness.agentManager.emitActivity(agentId, {
    kind: 'text',
    summary: 'starting…',
    content: 'starting work',
  });

  // The dashboard's kill-agent action calls agentManager.kill(agentId), which
  // (in our fake) emits agent-error + agent-done. We expect agent-done with
  // status='killed' on the wire.
  client.send({ action: 'kill-agent', agentId });

  const done = await client.waitFor('agent-done', 5000);
  const agent = (done.payload as { agent: { status: string } }).agent;
  assert.equal(agent.status, 'killed', 'killed agent has status=killed');
  assert.ok(harness.agentManager.wasKilled(agentId), 'manager records kill call');
});

test('2.3 spawn → emitError → server broadcasts agent-output (stderr) + agent-error', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'spawn-agent', project: 'demo', feature: 'error-path' });
  const spawned = await client.waitFor('agent-spawned', 5000);
  const agentId = (spawned.payload as { id: string }).id;

  // Drive an error directly through the fake.
  const errorPromise = client.collect({
    until: (m) => m.type === 'agent-error',
    timeoutMs: 5000,
  });
  harness.agentManager.emitError(agentId, 'simulated upstream 503');
  const events = await errorPromise;

  // The handler at dashboard-server.ts:1495 broadcasts:
  //   1. agent-output with a `stderr` entry summarising the error
  //   2. agent-error with { agentId, error }
  // Ordering matters — pinned via snapshot.
  const types = events.map((e) => e.type);
  assert.ok(types.includes('agent-output'), 'stderr surfaced as agent-output');
  assert.ok(types.includes('agent-error'), 'agent-error broadcast');
  const outputIdx = types.indexOf('agent-output');
  const errorIdx = types.indexOf('agent-error');
  assert.ok(outputIdx < errorIdx, 'agent-output (stderr) must precede agent-error');

  matchSnapshot(
    events.map((m: WireMessage) => normaliseEvent(m, agentId)),
    { name: 'agent-stream-2.3-error-path' },
  );
});

test('2.5 spawn → send-input is forwarded to agentManager', async (t) => {
  const harness = await bootDashboard();
  t.after(() => harness.stop());

  const client = await harness.connectClient();
  t.after(() => client.close());
  await client.waitFor('init', 5000);

  client.send({ action: 'spawn-agent', project: 'demo', feature: 'awaiting-input' });
  const spawned = await client.waitFor('agent-spawned', 5000);
  const agentId = (spawned.payload as { id: string }).id;

  // The send-input handler doesn't broadcast — it just forwards to the
  // agent manager. Verify the call landed via the FakeAgentManager
  // inspection API.
  client.send({ action: 'send-input', agentId, text: 'first input' });
  client.send({ action: 'send-input', agentId, text: 'second input' });

  // WS messages travel asynchronously. We can't inspect receivedInputs
  // until both send-input messages have been processed server-side.
  // Sync barrier: `get-state` triggers a fresh `init` reply, which the
  // server only sends AFTER all preceding WS messages have been dispatched.
  client.send({ action: 'get-state' });
  await client.waitFor('init', 5000);

  const received = harness.agentManager.receivedInputs();
  assert.deepEqual(
    received,
    [
      { agentId, text: 'first input' },
      { agentId, text: 'second input' },
    ],
    'both send-input messages forwarded to manager in order',
  );
});

/**
 * Reduce a wire message to a snapshot-friendly form. Drops:
 *   - the full AgentState (large; we only need its `status` + `kind`)
 *   - timestamp / agentId / runId (volatile)
 * Pins: ordering, event types, activity kinds, broadcast `runId` presence.
 */
function normaliseEvent(m: WireMessage, agentId: string): unknown {
  const stripped = stripVolatile(m) as { type: string; payload: any };
  if (stripped.type === 'agent-spawned') {
    return { type: stripped.type, agentStatus: stripped.payload.status };
  }
  if (stripped.type === 'agent-output') {
    return {
      type: stripped.type,
      entries: stripped.payload.entries.map((e: any) => ({
        kind: e.kind,
        tool: e.tool ?? null,
        stage: e.stage,
        type: e.type,
      })),
      hasRunId: stripped.payload.runId !== undefined && stripped.payload.runId !== null,
    };
  }
  if (stripped.type === 'agent-done') {
    return {
      type: stripped.type,
      agentStatus: stripped.payload.agent.status,
    };
  }
  // Drop the rest (active-runs noise, etc.) — they're not part of the
  // contract for this scenario. If they appear here it's intentional drift.
  return { type: stripped.type };
}
