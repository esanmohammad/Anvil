/**
 * Unit tests for TurnRecorder — v2 ADR §2.1 / §2.5.
 *
 * Covers:
 *   a) startTurn records `assistant-start` with a stable idempotency key.
 *   b) Concurrent recorder instances do not cross-pollinate turn counters.
 *   c) runTool records `tool_use:N` AND `tool_result:N`, executes the
 *      exec callback exactly once on live, returns its NeutralToolResult.
 *   d) Replay path — when the underlying runtime returns recorded
 *      payloads, runTool short-circuits the executor (exec never fires).
 *   e) endTurn records `assistant-end` with provenance + usage.
 *   f) flushPartial emits an AssistantPartial through the sink with the
 *      same turnUuid that startTurn minted; idempotent across calls.
 *   g) NullTurnRecorder factory produces a recorder whose calls all
 *      complete cleanly with no persisted side effects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TurnRecorder,
  createNullTurnRecorder,
  createNullEffectRuntime,
} from '../index.js';
import type {
  AssistantPartial,
  EffectInvokeOptions,
  EffectRuntimeLike,
  NeutralToolResult,
} from '../types.js';

interface RecordedEffect {
  name: string;
  opts?: EffectInvokeOptions;
  /** What fn() resolved to on this invocation (or undefined if replayed). */
  payload?: unknown;
  /** True when fn() was actually invoked (live); false when replayed. */
  fnRan: boolean;
}

/** Test-double EffectRuntime that records every call and supports
 *  pre-seeding replay payloads keyed by effect name. */
function buildFakeRuntime(seed: Record<string, unknown> = {}): {
  runtime: EffectRuntimeLike;
  log: RecordedEffect[];
} {
  const log: RecordedEffect[] = [];
  const runtime: EffectRuntimeLike = {
    async effect<T>(name: string, fn: () => Promise<T>, opts?: EffectInvokeOptions): Promise<T> {
      if (name in seed) {
        log.push({ name, opts, fnRan: false, payload: seed[name] });
        return seed[name] as T;
      }
      const payload = await fn();
      log.push({ name, opts, fnRan: true, payload });
      return payload;
    },
  };
  return { runtime, log };
}

describe('TurnRecorder', () => {
  it('records assistant-start with a stable idempotency key', async () => {
    const { runtime, log } = buildFakeRuntime();
    const sink: AssistantPartial[] = [];
    const recorder = new TurnRecorder({
      runtime,
      partialSink: (p) => { sink.push(p); },
      runId: 'r1', stepId: 'step-a',
      uuid: (() => { let n = 0; return () => `uuid-${n++}`; })(),
    });

    const { turn, turnUuid } = await recorder.startTurn({
      model: 'openrouter/qwen3',
      provider: 'openrouter',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(turn, 0);
    assert.equal(turnUuid, 'uuid-0');
    assert.equal(log.length, 1);
    assert.equal(log[0].name, 'turn:0:assistant-start');
    assert.equal(typeof log[0].opts?.idempotencyKey, 'string');
    assert.ok((log[0].opts!.idempotencyKey as string).length >= 32);
  });

  it('seeds the turn counter from deps.initialTurn (§2.5.1 resume)', async () => {
    const { runtime, log } = buildFakeRuntime();
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's',
      initialTurn: 3, // prior adapter recorded turns 0..2
    });
    const { turn } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });
    assert.equal(turn, 3, 'resumed recorder continues past the prior adapter, not from 0');
    assert.equal(log[0].name, 'turn:3:assistant-start');
  });

  it('keeps per-recorder turn counters isolated', async () => {
    const a = new TurnRecorder({
      runtime: buildFakeRuntime().runtime,
      partialSink: () => {},
      runId: 'r', stepId: 's',
    });
    const b = new TurnRecorder({
      runtime: buildFakeRuntime().runtime,
      partialSink: () => {},
      runId: 'r', stepId: 's',
    });

    await a.startTurn({ model: 'm', provider: 'openrouter', messages: [] });
    await a.startTurn({ model: 'm', provider: 'openrouter', messages: [] });
    const { turn: bTurn } = await b.startTurn({ model: 'm', provider: 'openrouter', messages: [] });

    assert.equal(bTurn, 0, 'second recorder starts at turn 0, ignoring first recorder');
  });

  it('runTool records tool_use AND tool_result, exec runs exactly once', async () => {
    const { runtime, log } = buildFakeRuntime();
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's',
    });
    const { turn } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });

    let execCalls = 0;
    const result = await recorder.runTool(turn, 'write_file', { path: 'x' }, 'idem-1', async () => {
      execCalls += 1;
      return { toolUseId: 'tc-1', toolName: 'write_file', ok: true, content: 'ok' };
    });

    assert.equal(execCalls, 1);
    assert.equal(result.content, 'ok');
    const names = log.map((e) => e.name);
    assert.deepEqual(names, [
      'turn:0:assistant-start',
      'turn:0:tool_use:0',
      'turn:0:tool_result:0',
    ]);
    assert.equal(log[1].opts?.idempotencyKey, 'idem-1');
  });

  it('replay short-circuits the executor — recorded tool_result wins', async () => {
    const recordedResult: NeutralToolResult = {
      toolUseId: 'tc-1', toolName: 'write_file', ok: true, content: 'recorded-output',
    };
    const { runtime, log } = buildFakeRuntime({
      'turn:0:tool_result:0': recordedResult,
    });
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's',
    });
    const { turn } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });

    let execCalls = 0;
    const result = await recorder.runTool(turn, 'write_file', { path: 'x' }, 'idem-1', async () => {
      execCalls += 1;
      return { toolUseId: 'tc-1', toolName: 'write_file', ok: true, content: 'LIVE-VALUE' };
    });

    assert.equal(execCalls, 0, 'exec must NOT fire when tool_result is replayed');
    assert.equal(result.content, 'recorded-output');
    // tool_use was still recorded structurally; only tool_result was replayed.
    assert.equal(log.find((e) => e.name === 'turn:0:tool_result:0')?.fnRan, false);
  });

  it('endTurn records assistant-end with provenance + usage', async () => {
    const { runtime, log } = buildFakeRuntime();
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's',
    });
    const { turn } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });

    await recorder.endTurn(
      turn,
      'completed text',
      'end_turn',
      { inputTokens: 12, outputTokens: 34 },
      { segments: [{ model: 'm', provider: 'openrouter', range: [0, 14], source: 'live' }] },
    );

    const end = log.find((e) => e.name === 'turn:0:assistant-end');
    assert.ok(end, 'assistant-end must be recorded');
    assert.deepEqual((end!.payload as { usage: unknown }).usage, { inputTokens: 12, outputTokens: 34 });
    assert.equal((end!.payload as { stopReason: string }).stopReason, 'end_turn');
  });

  it('flushPartial emits to sink with the turn\'s minted turnUuid', async () => {
    const { runtime } = buildFakeRuntime();
    const sink: AssistantPartial[] = [];
    const recorder = new TurnRecorder({
      runtime,
      partialSink: (p) => { sink.push(p); },
      runId: 'run-x', stepId: 'step-y',
      uuid: () => 'fixed-uuid',
      nowIso: () => '2026-05-25T00:00:00Z',
    });
    const { turn } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });

    recorder.flushPartial(turn, 'partial text here', 2, 'upstream');

    assert.equal(sink.length, 1);
    assert.deepEqual(sink[0], {
      runId: 'run-x',
      stepId: 'step-y',
      turnUuid: 'fixed-uuid',
      turn: 0,
      text: 'partial text here',
      toolUsesEmitted: 2,
      reason: 'upstream',
      recordedAt: '2026-05-25T00:00:00Z',
    });
  });

  it('flushPartial is a no-op when startTurn was never called', () => {
    const sink: AssistantPartial[] = [];
    const recorder = new TurnRecorder({
      runtime: createNullEffectRuntime(),
      partialSink: (p) => { sink.push(p); },
      runId: 'r', stepId: 's',
    });
    recorder.flushPartial(0, 'stale', 0, 'abort');
    assert.equal(sink.length, 0);
  });

  it('startTurn reconstructs `replayed` from a recorded assistant-end via peekRecorded (§H3)', async () => {
    // Simulate a turn already in the durable log: assistant-end + one
    // completed tool. peekRecorded returns these; the recorder must
    // reconstruct the full AssistantTurn so the adapter skips the network.
    const recorded: Record<string, unknown> = {
      'turn:0:assistant-start': { turnUuid: 'u', model: 'm', provider: 'openrouter' },
      'turn:0:tool_use:0': { name: 'write_file', arguments: { path: 'a.txt' }, idempotencyKey: 'k0' },
      'turn:0:tool_result:0': { toolUseId: 'tc0', toolName: 'write_file', ok: true, content: 'wrote' },
      'turn:0:assistant-end': {
        text: 'all done',
        stopReason: 'end_turn',
        usage: { inputTokens: 11, outputTokens: 7 },
        provenance: { segments: [{ model: 'm', provider: 'openrouter', range: [0, 8], source: 'live' }] },
        historyDelta: [{ role: 'assistant', content: 'all done' }],
        model: 'm',
        provider: 'openrouter',
      },
    };
    const runtime: EffectRuntimeLike = {
      async effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
        return (name in recorded ? recorded[name] : await fn()) as T;
      },
      peekRecorded<T = unknown>(name: string): T | undefined {
        return (name in recorded ? recorded[name] : undefined) as T | undefined;
      },
    };
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's', uuid: () => 'u',
    });

    const { turn, turnUuid, replayed } = await recorder.startTurn({
      model: 'm', provider: 'openrouter', messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(turn, 0);
    assert.equal(turnUuid, 'u');
    assert.ok(replayed, 'assistant-end present → replayed reconstructed');
    assert.equal(replayed!.text, 'all done');
    assert.equal(replayed!.stopReason, 'end_turn');
    assert.deepEqual(replayed!.usage, { inputTokens: 11, outputTokens: 7 });
    assert.equal(replayed!.toolUses.length, 1);
    assert.deepEqual(replayed!.toolUses[0], {
      id: 'tc0', name: 'write_file', arguments: { path: 'a.txt' }, idempotencyKey: 'k0',
    });
    assert.equal(replayed!.toolResults.length, 1);
    assert.equal(replayed!.toolResults[0].content, 'wrote');
    assert.deepEqual(replayed!.historyDelta, [{ role: 'assistant', content: 'all done' }]);
  });

  it('startTurn does NOT reconstruct when assistant-end is absent (live path)', async () => {
    // Only assistant-start recorded — the turn never finished. No replay.
    const recorded: Record<string, unknown> = {
      'turn:0:assistant-start': { turnUuid: 'u', model: 'm', provider: 'openrouter' },
    };
    const runtime: EffectRuntimeLike = {
      async effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
        return (name in recorded ? recorded[name] : await fn()) as T;
      },
      peekRecorded<T = unknown>(name: string): T | undefined {
        return (name in recorded ? recorded[name] : undefined) as T | undefined;
      },
    };
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's', uuid: () => 'u',
    });
    const { replayed } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });
    assert.equal(replayed, undefined, 'no assistant-end → no replay, adapter runs live');
  });

  it('endTurn records historyDelta + model/provider into the assistant-end payload (§H3)', async () => {
    const recorded = new Map<string, unknown>();
    const runtime: EffectRuntimeLike = {
      async effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const v = await fn();
        recorded.set(name, v);
        return v;
      },
    };
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'r', stepId: 's', uuid: () => 'u',
    });
    const { turn } = await recorder.startTurn({ model: 'qwen/q', provider: 'openrouter', messages: [] });
    const delta = [{ role: 'assistant', content: 'x', tool_calls: [{ id: 'tc' }] }];
    await recorder.endTurn(turn, 'x', 'tool_use', { inputTokens: 3, outputTokens: 1 }, { segments: [] }, delta);

    const end = recorded.get('turn:0:assistant-end') as Record<string, unknown>;
    assert.deepEqual(end.historyDelta, delta);
    assert.equal(end.model, 'qwen/q');
    assert.equal(end.provider, 'openrouter');
  });

  it('NullTurnRecorder factory yields a working recorder that persists nothing', async () => {
    const recorder = createNullTurnRecorder();
    const { turn } = await recorder.startTurn({ model: 'm', provider: 'openrouter', messages: [] });
    let execCalls = 0;
    const result = await recorder.runTool(turn, 'noop', {}, 'idem', async () => {
      execCalls += 1;
      return { toolUseId: 't', toolName: 'noop', ok: true, content: 'ran' };
    });
    await recorder.endTurn(turn, 'text', 'end_turn', { inputTokens: 1, outputTokens: 1 }, { segments: [] });
    recorder.flushPartial(turn, '', 0, 'abort');
    // All structural calls succeed; exec ran live because there's no
    // replay log; no persistence side-effect we can observe.
    assert.equal(execCalls, 1);
    assert.equal(result.content, 'ran');
  });
});
