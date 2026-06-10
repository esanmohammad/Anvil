/**
 * Unit tests for the EventReplay ring buffer + topic mapping.
 *
 * Pure in-process tests — no harness, no boot, no WS. Verify the
 * primitives in isolation before Phase 3 wires them into services.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReplay } from '../events/replay.js';
import { roomsForEvent } from '../events/topics.js';
import { toLegacyWire } from '../events/wire-translate.js';
import { envelope, type DashboardEvent, type Topic } from '../events/types.js';

function ev<K extends DashboardEvent['kind']>(
  kind: K,
  payload: any,
  topics: Topic[],
  ts: number,
): DashboardEvent {
  return envelope(kind, payload, topics, () => ts) as DashboardEvent;
}

test('replay: appends events to every topic in `topics`', () => {
  const replay = createReplay();
  const e = ev(
    'run.started',
    { runId: 'r1', project: 'p', type: 'build', description: 'd', model: 'm' },
    ['global', 'run:r1', 'project:p'],
    1000,
  );
  replay.append(e);

  assert.equal(replay.since('global').length, 1, 'global got 1 event');
  assert.equal(replay.since('run:r1').length, 1, 'run:r1 got 1 event');
  assert.equal(replay.since('project:p').length, 1, 'project:p got 1 event');
  assert.equal(replay.since('run:other').length, 0, 'unrelated room is empty');
});

test('replay: since(room, sinceId) returns events AFTER the cursor', () => {
  const replay = createReplay();
  const e1 = ev('run.started', { runId: 'r1', project: 'p', type: 'build', description: 'd', model: 'm' }, ['run:r1'], 1000);
  const e2 = ev('run.state-changed', { runId: 'r1', status: 'running' }, ['run:r1'], 1001);
  const e3 = ev('run.completed', { runId: 'r1', status: 'completed', durationMs: 100 }, ['run:r1'], 1002);
  replay.append(e1);
  replay.append(e2);
  replay.append(e3);

  assert.deepEqual(replay.since('run:r1').map((x) => x.id), [e1.id, e2.id, e3.id]);
  assert.deepEqual(replay.since('run:r1', e1.id).map((x) => x.id), [e2.id, e3.id]);
  assert.deepEqual(replay.since('run:r1', e2.id).map((x) => x.id), [e3.id]);
  assert.deepEqual(replay.since('run:r1', e3.id), []);
});

test('replay: unknown sinceId returns all events (full replay)', () => {
  const replay = createReplay();
  const e = ev('runs.list', { runs: [] }, ['global'], 1000);
  replay.append(e);

  // Client passed a stale cursor we no longer have — fall back to
  // delivering everything we still retain.
  const result = replay.since('global', 'definitely-not-an-id');
  assert.equal(result.length, 1);
});

test('replay: enforces maxPerRoom cap (drop-oldest)', () => {
  const replay = createReplay({ maxPerRoom: 3 });
  for (let i = 0; i < 5; i++) {
    replay.append(ev('agent.output', { entries: [], runId: 'r' }, ['run:r'], 1000 + i));
  }
  const stored = replay.since('run:r');
  assert.equal(stored.length, 3, 'only 3 events retained');
  // The OLDEST two (ts=1000, 1001) should have been evicted.
  assert.deepEqual(stored.map((x) => x.ts), [1002, 1003, 1004]);
});

test('replay: enforces maxBytesPerRoom cap (drop-oldest)', () => {
  // Each "byte" in this test = 10 bytes of synthetic event size.
  const replay = createReplay({
    maxBytesPerRoom: 30,
    sizeOf: () => 10,
  });
  for (let i = 0; i < 5; i++) {
    replay.append(ev('agent.output', { entries: [], runId: 'r' }, ['run:r'], 1000 + i));
  }
  const stats = replay.stats();
  const room = stats.perRoom.find((r) => r.room === 'run:r');
  assert.ok(room, 'run:r tracked');
  assert.ok(room!.bytes <= 30, `byte cap respected (was ${room!.bytes})`);
  assert.ok(room!.count <= 3, `count derived from byte cap (was ${room!.count})`);
});

test('replay: clear() wipes everything', () => {
  const replay = createReplay();
  replay.append(ev('state', { state: {} }, ['global'], 1000));
  assert.equal(replay.since('global').length, 1);
  replay.clear();
  assert.equal(replay.since('global').length, 0);
  assert.equal(replay.stats().rooms, 0);
});

test('topics: run.started fans out to global + run + project', () => {
  const e = ev(
    'run.started',
    { runId: 'r1', project: 'demo', type: 'build', description: 'd', model: 'm' },
    [],
    1000,
  );
  const rooms = roomsForEvent(e);
  assert.deepEqual(rooms, ['global', 'run:r1', 'project:demo']);
});

test('topics: agent.output fans out to global + run:<id> during migration', () => {
  // During the raw-WS → socket.io transition agent events publish to
  // both `global` and `run:<id>` so default-subscribed clients still see
  // the firehose (raw-WS parity). Drop `global` from this mapping once
  // the frontend opts into per-run subscriptions.
  const eRun = ev('agent.output', { entries: [], runId: 'r1' }, [], 1000);
  assert.deepEqual(roomsForEvent(eRun), ['global', 'run:r1']);

  const eGlobal = ev('agent.output', { entries: [] }, [], 1000);
  assert.deepEqual(roomsForEvent(eGlobal), ['global']);
});

test('topics: cost.snapshot fans out to global + cost + project (+ run when present)', () => {
  const e = ev(
    'cost.snapshot',
    { project: 'demo', runId: 'r1', snapshot: {} },
    [],
    1000,
  );
  assert.deepEqual(roomsForEvent(e), ['global', 'cost', 'project:demo', 'run:r1']);

  const e2 = ev(
    'cost.snapshot',
    { project: 'demo', snapshot: {} },
    [],
    1000,
  );
  assert.deepEqual(roomsForEvent(e2), ['global', 'cost', 'project:demo']);
});

test('topics: plan events route to global + plan:<slug>', () => {
  const e = ev('plan.comment-added', { planSlug: 'add-button', comment: {} }, [], 1000);
  assert.deepEqual(roomsForEvent(e), ['global', 'plan:add-button']);
});

test('§H3 pipeline.step-cost routes to global + cost + run:<id>', () => {
  const e = ev(
    'pipeline.step-cost',
    { runId: 'r1', stepId: 'build', costByModel: {}, prefillReinjectionUsd: 0, totalCostUsd: 0, continuation: null },
    [],
    1000,
  );
  assert.deepEqual(roomsForEvent(e), ['global', 'cost', 'run:r1']);
});

test('§H3 pipeline.step-cost legacy wire string is the exact contract the client keys on', () => {
  // The frontend's WIRE_TO_KIND + main.tsx handleServerMessage both switch on
  // the literal 'pipeline-step-cost'. That string crosses the package
  // boundary untyped, so pin it here — a rename in wire-translate.ts that
  // isn't mirrored client-side would silently drop the per-model cost.
  const payload = {
    runId: 'r1',
    stepId: 'build',
    costByModel: { sonnet: { model: 'sonnet', costUsd: 0.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, prefilledInputTokens: 0 } },
    prefillReinjectionUsd: 0.01,
    totalCostUsd: 0.51,
    continuation: { successors: ['gpt-4o'], predecessors: ['kimi/k2'] },
  };
  const wire = toLegacyWire(ev('pipeline.step-cost', payload, [], 1000));
  assert.ok(wire, 'pipeline.step-cost must translate to a legacy wire message');
  assert.equal(wire.type, 'pipeline-step-cost');
  assert.deepEqual(wire.payload, payload);
});

test('topics: incident events route to global + incident', () => {
  const e = ev('incident.ingested', { incident: { id: 'i1' } }, [], 1000);
  assert.deepEqual(roomsForEvent(e), ['global', 'incident']);
});

test('nextEventId: produces strictly-ordered ids within a tick', () => {
  const e1 = envelope('state', { state: {} }, ['global'], () => 1000);
  const e2 = envelope('state', { state: {} }, ['global'], () => 1000);
  const e3 = envelope('state', { state: {} }, ['global'], () => 1001);
  // Same ts → seq increments; later ts → strict order regardless of seq.
  assert.ok(e1.id < e2.id, 'sequential within tick');
  assert.ok(e2.id < e3.id, 'ts boundary moves forward');
});
