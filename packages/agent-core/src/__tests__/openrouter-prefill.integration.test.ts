/**
 * Integration tests for the H2 turn-level durable resume machinery in
 * the OpenRouter adapter (v2 ADR §2.1 / §2.3 / §2.5), driven against a
 * real HTTP server (`MockUpstream`) that can cut its SSE stream at a
 * chosen frame to simulate a model dying mid-output.
 *
 * Proves:
 *   1. Burn mid-SSE → the partial sink receives the EXACT assistant
 *      text streamed before the cut (not an empty string). This is the
 *      whole point of surfacing the accumulator out of consumeSSE.
 *   2. Mid-`tool_use` truncation (§2.1.1) → a tool_call whose streamed
 *      args are incomplete JSON is NOT counted in `toolUsesEmitted`.
 *   3. Prefill (§2.3) → when config.prefill is present, the adapter's
 *      outbound request carries the re-presented tool_use/tool_result
 *      pair AND a trailing assistant message with the partial text, so
 *      the new model continues from the exact stopping point.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { OpenRouterAdapter } from '../openrouter-adapter.js';
import { TurnRecorder } from '../turn-recorder/index.js';
import type {
  AssistantPartial,
  EffectRuntimeLike,
  Prefill,
  PrefillTurn,
} from '../turn-recorder/types.js';
import type { ModelAdapterConfig, ToolExecutorLike } from '../types.js';
import { resetAllPools } from '../fetch-pool.js';
import { MockUpstream } from './util/mock-upstream.js';

// ── Live pass-through effect runtime (no persistence) ─────────────────
function liveRuntime(): EffectRuntimeLike {
  return { async effect<T>(_n: string, fn: () => Promise<T>): Promise<T> { return fn(); } };
}

// ── Replay runtime: serves recorded effect payloads by name + peek ─────
// Simulates a crash-resume where the durable log already holds the turn's
// sub-effects. `effect()` returns the recorded payload (replay); `fn` runs
// only for un-recorded names. `peekRecorded` lets startTurn detect a
// finished turn so the adapter skips the upstream call.
function replayRuntime(recorded: Record<string, unknown>): EffectRuntimeLike {
  return {
    async effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
      return (name in recorded ? recorded[name] : await fn()) as T;
    },
    peekRecorded<T = unknown>(name: string): T | undefined {
      return (name in recorded ? recorded[name] : undefined) as T | undefined;
    },
  };
}

// ── Recording runtime: stores every effect payload for inspection ─────
function recordingRuntime(): { runtime: EffectRuntimeLike; recorded: Map<string, unknown> } {
  const recorded = new Map<string, unknown>();
  return {
    recorded,
    runtime: {
      async effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const v = await fn();
        recorded.set(name, v);
        return v;
      },
    },
  };
}

// ── Discarding output sink ────────────────────────────────────────────
function nullSink(): NodeJS.WritableStream {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

// ── Minimal tool executor advertising one write_file tool ─────────────
function fakeExecutor(): ToolExecutorLike {
  return {
    listSchemas() {
      return [{
        name: 'write_file',
        description: 'write a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      }];
    },
    async execute() {
      return { content: 'ok', isError: false };
    },
  };
}

function buildConfig(over: Partial<ModelAdapterConfig> = {}): ModelAdapterConfig {
  return {
    userPrompt: 'do the thing',
    projectPrompt: 'you are a coder',
    model: 'qwen/qwen3',
    workingDir: '/tmp',
    stage: 'build',
    persona: 'engineer',
    sessionId: 'sess-1',
    ...over,
  };
}

describe('OpenRouterAdapter — H2 turn-level durable resume', () => {
  let up: MockUpstream;

  beforeEach(async () => {
    await resetAllPools();
    up = await MockUpstream.start();
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_BASE_URL = up.baseUrl;
  });

  afterEach(async () => {
    await up.stop();
    await resetAllPools();
    delete process.env.OPENROUTER_BASE_URL;
  });

  it('flushes the streamed partial text when the stream dies mid-SSE', async () => {
    const partials: AssistantPartial[] = [];
    const recorder = new TurnRecorder({
      runtime: liveRuntime(),
      partialSink: (p) => { partials.push(p); },
      runId: 'run-1', stepId: 'build',
    });

    up.script([
      MockUpstream.textFrame('Hello, I am writing'),
      MockUpstream.textFrame(' a function to add'),
      MockUpstream.textFrame(' two numbers'),
    ]).cutAfterFrames(2); // die after 2 text frames

    const adapter = new OpenRouterAdapter();
    await assert.rejects(
      adapter.run(buildConfig({ turnRecorder: recorder }), nullSink()),
    );

    assert.equal(partials.length, 1, 'exactly one partial flushed');
    assert.equal(
      partials[0].text,
      'Hello, I am writing a function to add',
      'partial carries the text streamed before the cut',
    );
    assert.equal(partials[0].turn, 0);
    assert.ok(partials[0].turnUuid.length > 0);
  });

  it('excludes a mid-args-truncated tool_call from toolUsesEmitted (§2.1.1)', async () => {
    const partials: AssistantPartial[] = [];
    const recorder = new TurnRecorder({
      runtime: liveRuntime(),
      partialSink: (p) => { partials.push(p); },
      runId: 'run-2', stepId: 'build',
    });

    up.script([
      MockUpstream.textFrame('working'),
      // complete tool call — parses
      MockUpstream.toolCallFrame({ index: 0, id: 'tc1', name: 'write_file', argsChunk: '{"path":"a.txt","content":"hi"}' }),
      // truncated tool call — unparseable JSON
      MockUpstream.toolCallFrame({ index: 1, id: 'tc2', name: 'write_file', argsChunk: '{"path":"b.txt' }),
    ]).cutAfterFrames(3);

    const adapter = new OpenRouterAdapter();
    await assert.rejects(
      adapter.run(buildConfig({ turnRecorder: recorder, toolExecutor: fakeExecutor() }), nullSink()),
    );

    assert.equal(partials.length, 1);
    assert.equal(
      partials[0].toolUsesEmitted,
      1,
      'only the cleanly-parsed tool_call is counted; truncated one is dropped',
    );
  });

  it('does NOT flush a partial when the SSE completed but a post-stream effect throws', async () => {
    const partials: AssistantPartial[] = [];
    // Runtime that throws specifically on the assistant-end effect — a
    // determinism-style failure AFTER the stream completed cleanly.
    const throwingOnEnd: EffectRuntimeLike = {
      async effect<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (name.endsWith(':assistant-end')) throw new Error('determinism violation on end');
        return fn();
      },
    };
    const recorder = new TurnRecorder({
      runtime: throwingOnEnd,
      partialSink: (p) => { partials.push(p); },
      runId: 'run-3', stepId: 'build',
    });

    up.script([
      MockUpstream.textFrame('A complete answer'),
      MockUpstream.finishFrame('stop'),
      MockUpstream.usageFrame({ prompt_tokens: 10, completion_tokens: 4 }),
      MockUpstream.doneFrame(),
    ]).noCut();

    const adapter = new OpenRouterAdapter();
    await assert.rejects(adapter.run(buildConfig({ turnRecorder: recorder }), nullSink()));

    assert.equal(
      partials.length,
      0,
      'SSE completed → no partial flushed even though endTurn threw (no spurious complete-text partial)',
    );
  });

  it('REPLAY-SKIP: a fully-recorded terminal turn makes ZERO upstream calls (§H3)', async () => {
    // The whole point of the cutover: on crash-resume, a turn already in
    // the durable log must NOT re-hit the model.
    const recorder = new TurnRecorder({
      runtime: replayRuntime({
        'turn:0:assistant-start': { turnUuid: 'u', model: 'qwen/qwen3', provider: 'openrouter' },
        'turn:0:assistant-end': {
          text: 'the recorded answer',
          stopReason: 'end_turn',
          usage: { inputTokens: 20, outputTokens: 4 },
          provenance: { segments: [] },
          historyDelta: [],
          model: 'qwen/qwen3',
          provider: 'openrouter',
        },
      }),
      partialSink: () => {},
      runId: 'run-replay', stepId: 'build',
    });
    // Script frames so that IF the adapter wrongly called upstream, the
    // test would still terminate — but we assert it never connects.
    up.script([MockUpstream.textFrame('LIVE — should never run'), MockUpstream.finishFrame('stop'), MockUpstream.doneFrame()]).noCut();

    const adapter = new OpenRouterAdapter();
    const res = await adapter.run(buildConfig({ turnRecorder: recorder }), nullSink());

    assert.equal(up.capturedRequests().length, 0, 'replayed turn must make NO upstream request');
    assert.equal(res.output, 'the recorded answer', 'output comes from the recorded turn, not the wire');
  });

  it('REPLAY-SKIP: a recorded tool turn replays without re-executing the tool or calling upstream (§H3)', async () => {
    let execRan = false;
    const executor: ToolExecutorLike = {
      listSchemas() {
        return [{ name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} } }];
      },
      async execute() { execRan = true; return { content: 'LIVE-EXEC', isError: false }; },
    };
    const recorder = new TurnRecorder({
      runtime: replayRuntime({
        // turn 0: a tool turn (one completed tool)
        'turn:0:assistant-start': { turnUuid: 'u0', model: 'qwen/qwen3', provider: 'openrouter' },
        'turn:0:tool_use:0': { name: 'write_file', arguments: { path: 'a.txt', content: 'hi' }, idempotencyKey: 'k0' },
        'turn:0:tool_result:0': { toolUseId: 'tc0', toolName: 'write_file', ok: true, content: 'recorded-write' },
        'turn:0:assistant-end': {
          text: 'working', stopReason: 'tool_use',
          usage: { inputTokens: 30, outputTokens: 2 },
          provenance: { segments: [] },
          historyDelta: [
            { role: 'assistant', content: 'working', tool_calls: [{ id: 'tc0', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }] },
            { role: 'tool', content: 'recorded-write', tool_call_id: 'tc0' },
          ],
          model: 'qwen/qwen3', provider: 'openrouter',
        },
        // turn 1: terminal continuation
        'turn:1:assistant-start': { turnUuid: 'u1', model: 'qwen/qwen3', provider: 'openrouter' },
        'turn:1:assistant-end': {
          text: ' and done', stopReason: 'end_turn',
          usage: { inputTokens: 35, outputTokens: 3 },
          provenance: { segments: [] }, historyDelta: [],
          model: 'qwen/qwen3', provider: 'openrouter',
        },
      }),
      partialSink: () => {},
      runId: 'run-replay-tools', stepId: 'build',
    });
    up.script([MockUpstream.textFrame('LIVE — should never run'), MockUpstream.finishFrame('stop'), MockUpstream.doneFrame()]).noCut();

    const adapter = new OpenRouterAdapter();
    const res = await adapter.run(buildConfig({ turnRecorder: recorder, toolExecutor: executor }), nullSink());

    assert.equal(execRan, false, 'recorded tool_result is replayed — exec must NOT re-run the side effect');
    assert.equal(up.capturedRequests().length, 0, 'no upstream calls across the replayed multi-turn run');
    assert.equal(res.output, 'working and done', 'output is the concatenation of both replayed turns');
  });

  it('records TWO-SEGMENT provenance + prefilledInputTokens when a prefill is consumed (§2.6/§2.7)', async () => {
    const { runtime, recorded } = recordingRuntime();
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'run-prov', stepId: 'build',
    });
    const prefill: Prefill = {
      turnUuid: 'turn-A',
      text: 'partial from A',          // 14 chars
      toolUses: [],
      sourceProvider: 'openrouter',
      sourceModel: 'kimi/k2',
      sourceTokens: 99,
    };
    up.script([
      MockUpstream.textFrame(' continued by B'),
      MockUpstream.finishFrame('stop'),
      MockUpstream.usageFrame({ prompt_tokens: 120, completion_tokens: 5 }),
      MockUpstream.doneFrame(),
    ]).noCut();

    const adapter = new OpenRouterAdapter();
    await adapter.run(buildConfig({ model: 'qwen/qwen3', turnRecorder: recorder, prefill }), nullSink());

    const end = recorded.get('turn:0:assistant-end') as {
      usage: { prefilledInputTokens?: number };
      provenance: { segments: Array<{ model: string; range: [number, number]; source: string }> };
    };
    assert.ok(end, 'assistant-end recorded');
    assert.equal(end.usage.prefilledInputTokens, 99, 'prefill sourceTokens carved out for §2.6 reinjection');
    assert.equal(end.provenance.segments.length, 2, 'two segments: prefill + live');
    assert.deepEqual(end.provenance.segments[0], { model: 'kimi/k2', provider: 'openrouter', range: [0, 14], source: 'prefill' });
    assert.equal(end.provenance.segments[1].source, 'live');
    assert.equal(end.provenance.segments[1].model, 'qwen/qwen3');
    assert.deepEqual(end.provenance.segments[1].range, [14, 14 + ' continued by B'.length]);
  });

  it('re-presents a prefill (tool history + partial text) in the next request (§2.3)', async () => {
    const prefill: Prefill = {
      turnUuid: 'turn-abc',
      text: 'The partial answer so far',
      toolUses: [{
        id: 'tc-prev',
        name: 'read_file',
        input: { path: 'x.ts' },
        result: { toolUseId: 'tc-prev', toolName: 'read_file', ok: true, content: 'file contents here' },
        producedBy: 'openrouter',
      }],
      sourceProvider: 'openrouter',
      sourceTokens: 42,
    };

    // The resumed model just completes cleanly.
    up.script([
      MockUpstream.textFrame(' and the rest of the answer.'),
      MockUpstream.finishFrame('stop'),
      MockUpstream.usageFrame({ prompt_tokens: 100, completion_tokens: 8 }),
      MockUpstream.doneFrame(),
    ]).noCut();

    const adapter = new OpenRouterAdapter();
    await adapter.run(buildConfig({ prefill }), nullSink());

    const req = up.lastRequest();
    assert.ok(req, 'a request was captured');
    const messages = (req!.body as { messages: Array<Record<string, unknown>> }).messages;

    // Trailing assistant message carries the partial continuation.
    const assistantText = messages.find(
      (m) => m.role === 'assistant' && m.content === 'The partial answer so far',
    );
    assert.ok(assistantText, 'trailing assistant continuation present');

    // The recorded tool_use is re-presented as an assistant tool_call.
    const assistantToolCall = messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls)
        && (m.tool_calls as Array<{ function?: { name?: string } }>)[0]?.function?.name === 'read_file',
    );
    assert.ok(assistantToolCall, 'tool_use re-presented as assistant tool_call');

    // The recorded tool result is re-presented as a tool message.
    const toolResult = messages.find(
      (m) => m.role === 'tool' && m.content === 'file contents here',
    );
    assert.ok(toolResult, 'tool_result re-presented as tool message');
  });

  it('§Tier 2: splices priorMessages (completed prior turns) BEFORE the user message, in order', async () => {
    const priorMessages: PrefillTurn[] = [
      {
        userPrompt: 'explore the repo',
        text: 'I looked around',
        toolUses: [{
          id: 'tc-explore',
          name: 'grep',
          input: { pattern: 'foo' },
          result: { toolUseId: 'tc-explore', toolName: 'grep', ok: true, content: 'found foo' },
          producedBy: 'openrouter',
        }],
        producedBy: 'openrouter',
      },
    ];

    up.script([
      MockUpstream.textFrame('synthesizing'),
      MockUpstream.finishFrame('stop'),
      MockUpstream.usageFrame({ prompt_tokens: 200, completion_tokens: 3 }),
      MockUpstream.doneFrame(),
    ]).noCut();

    const adapter = new OpenRouterAdapter();
    await adapter.run(buildConfig({ userPrompt: 'now synthesize', priorMessages }), nullSink());

    const req = up.lastRequest();
    assert.ok(req);
    const messages = (req!.body as { messages: Array<Record<string, unknown>> }).messages;
    const roles = messages.map((m) => m.role);

    // Order: system, [prior turn: user, assistant(text+tool_calls), tool], then THIS phase's user.
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, 'explore the repo', 'prior phase prompt comes first');
    const priorAssistant = messages[2];
    assert.equal(priorAssistant.role, 'assistant');
    assert.equal(priorAssistant.content, 'I looked around', 'completed turn keeps text + tool_calls on ONE message');
    assert.equal((priorAssistant.tool_calls as Array<{ function?: { name?: string } }>)[0]?.function?.name, 'grep');
    assert.equal(messages[3].role, 'tool', 'tool result follows the combined assistant message');
    assert.equal(messages[3].content, 'found foo');
    // The CURRENT phase's user prompt is LAST (after all prior history).
    const lastUser = messages[messages.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.equal(lastUser.content, 'now synthesize', 'current prompt is appended after prior history');
    // No consecutive assistant messages from the combined-turn shape.
    for (let i = 1; i < roles.length; i++) {
      assert.ok(!(roles[i] === 'assistant' && roles[i - 1] === 'assistant'), `no consecutive assistant at ${i}`);
    }
  });

  it('§Tier 2: empty/absent priorMessages is byte-identical to the single-turn path', async () => {
    up.script([
      MockUpstream.textFrame('answer'),
      MockUpstream.finishFrame('stop'),
      MockUpstream.usageFrame({ prompt_tokens: 10, completion_tokens: 1 }),
      MockUpstream.doneFrame(),
    ]).noCut();

    const adapter = new OpenRouterAdapter();
    await adapter.run(buildConfig({ userPrompt: 'just this', priorMessages: [] }), nullSink());

    const messages = (up.lastRequest()!.body as { messages: Array<Record<string, unknown>> }).messages;
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user'], 'no prior history injected');
    assert.equal(messages[1].content, 'just this');
  });

  it('records a `stopReason:"burned"` sentinel assistant-end on a mid-SSE burn (§H3 Tier 1 #3)', async () => {
    const { runtime, recorded } = recordingRuntime();
    const recorder = new TurnRecorder({
      runtime, partialSink: () => {}, runId: 'run-burn-sentinel', stepId: 'build',
    });
    up.script([
      MockUpstream.textFrame('I started answering'),
      MockUpstream.textFrame(' but then'),
      MockUpstream.textFrame(' the stream died'),
    ]).cutAfterFrames(2);

    const adapter = new OpenRouterAdapter();
    await assert.rejects(adapter.run(buildConfig({ turnRecorder: recorder }), nullSink()));

    const end = recorded.get('turn:0:assistant-end') as { stopReason?: string; text?: string; historyDelta?: unknown[] } | undefined;
    assert.ok(end, 'a sentinel assistant-end is recorded for the burned turn so replay can skip it');
    assert.equal(end!.stopReason, 'burned', 'sentinel marks the turn as burned, not a real completion');
    assert.equal(end!.text, 'I started answering but then', 'sentinel carries the streamed-so-far partial text');
    assert.deepEqual(end!.historyDelta, [], 'burn before any message append → empty historyDelta');
  });

  it('REPLAY of a burned sentinel re-throws (re-burn) and makes ZERO upstream calls (§H3 Tier 1 #4)', async () => {
    // On crash-resume the burned turn must NOT re-hit the model; it replays
    // the sentinel, re-issues its recorded tools, then re-throws so the chain
    // walker re-derives the same model→turn mapping it had live.
    const recorder = new TurnRecorder({
      runtime: replayRuntime({
        'turn:0:assistant-start': { turnUuid: 'u0', model: 'qwen/qwen3', provider: 'openrouter' },
        'turn:0:assistant-end': {
          text: 'partial before burn',
          stopReason: 'burned',
          usage: { inputTokens: 0, outputTokens: 0 },
          provenance: { segments: [] },
          historyDelta: [],
          model: 'qwen/qwen3',
          provider: 'openrouter',
        },
      }),
      partialSink: () => {},
      runId: 'run-burn-replay', stepId: 'build',
    });
    up.script([MockUpstream.textFrame('LIVE — must never run'), MockUpstream.finishFrame('stop'), MockUpstream.doneFrame()]).noCut();

    const adapter = new OpenRouterAdapter();
    await assert.rejects(
      adapter.run(buildConfig({ turnRecorder: recorder }), nullSink()),
      (err: Error & { retryable?: boolean }) => err.name === 'UpstreamError' && err.retryable === true,
      'a replayed burned turn re-throws a retryable UpstreamError so chain-fallback advances',
    );
    assert.equal(up.capturedRequests().length, 0, 'replayed burned turn makes NO upstream request');
  });
});
