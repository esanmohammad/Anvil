/**
 * §H4 — turn recording + replay-equivalence for the Ollama AGENTIC adapter.
 *
 * The agentic port records per-turn assistant-start / tool_use / tool_result /
 * assistant-end and, crucially, HONORS `replayed` on a same-runId resume so the
 * recorded effects re-issue in order WITHOUT re-calling the upstream or
 * re-executing tools. This is the guarantee that prevents a crash-resume from
 * tripping a DeterminismViolation under FO1's runId reuse.
 *
 * Test 1 records a 2-turn (tool-call → text) run and asserts the effect log.
 * Test 2 replays that exact log and asserts ZERO upstream fetches + ZERO tool
 * executions, with byte-identical output.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { OllamaAdapter } from '../ollama-adapter.js';
import { TurnRecorder } from '../turn-recorder/index.js';
import type { EffectRuntimeLike, EffectInvokeOptions } from '../turn-recorder/types.js';
import type { ModelAdapterConfig, ToolExecutorLike, ToolCall, ToolSchema } from '../types.js';

function ollamaText(text: string): Response {
  return new Response(
    [
      JSON.stringify({ message: { content: text } }),
      JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 7, total_duration: 1_000_000 }),
    ].join('\n') + '\n',
    { status: 200 },
  );
}
function ollamaToolCall(name: string, args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      done: true, prompt_eval_count: 3, eval_count: 2, total_duration: 500_000,
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] },
    }) + '\n',
    { status: 200 },
  );
}

class StubWritable {
  write(): boolean { return true; }
  end(): void {}
  on(): void {}
}

class FakeExecutor implements ToolExecutorLike {
  calls: ToolCall[] = [];
  constructor(private readonly handlers: Record<string, () => { content: string; isError: boolean }>) {}
  listSchemas(): ToolSchema[] {
    return Object.keys(this.handlers).map((name) => ({
      name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} },
    }));
  }
  async execute(call: ToolCall): Promise<{ content: string; isError: boolean }> {
    this.calls.push(call);
    return this.handlers[call.name]();
  }
}

interface Logged { name: string; payload: unknown }
/** Record (seed empty) or replay (seed populated) fake EffectRuntime. */
function fakeRuntime(seed: Record<string, unknown> = {}): { runtime: EffectRuntimeLike; log: Logged[] } {
  const log: Logged[] = [];
  const runtime: EffectRuntimeLike = {
    async effect<T>(name: string, fn: () => Promise<T>, _opts?: EffectInvokeOptions): Promise<T> {
      if (name in seed) { log.push({ name, payload: seed[name] }); return seed[name] as T; }
      const payload = await fn();
      log.push({ name, payload });
      return payload;
    },
    peekRecorded<T = unknown>(name: string): T | undefined {
      return (name in seed ? seed[name] : undefined) as T | undefined;
    },
  };
  return { runtime, log };
}

const baseConfig: ModelAdapterConfig = {
  userPrompt: 'list the files then finish',
  model: 'qwen3:14b',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
  sessionId: 'run-oll',
};

let originalFetch: typeof fetch;
before(() => { originalFetch = globalThis.fetch; });
after(() => { globalThis.fetch = originalFetch; });

describe('OllamaAdapter — H4 recording + replay-equivalence', () => {
  // Shared between the two tests: test 1 records into `recordedLog`.
  let recordedLog: Logged[] = [];
  let liveFetchCount = 0;

  it('records assistant-start/tool_use/tool_result/assistant-end across a tool-call run', async () => {
    liveFetchCount = 0;
    globalThis.fetch = (async () => {
      liveFetchCount += 1;
      return liveFetchCount === 1 ? ollamaToolCall('list', {}) : ollamaText('done');
    }) as typeof fetch;

    const fx = new FakeExecutor({ list: () => ({ content: 'a.ts\nb.ts', isError: false }) });
    const { runtime, log } = fakeRuntime();
    const recorder = new TurnRecorder({ runtime, partialSink: () => {}, runId: 'run-oll', stepId: 'build' });

    const r = await new OllamaAdapter().run(
      { ...baseConfig, toolExecutor: fx, turnRecorder: recorder },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(r.output, 'done');
    assert.equal(liveFetchCount, 2, 'two upstream turns on the live path');
    assert.equal(fx.calls.length, 1, 'tool executed once on the live path');

    const names = log.map((e) => e.name);
    assert.ok(names.includes('turn:0:assistant-start'));
    assert.ok(names.includes('turn:0:tool_use:0'));
    assert.ok(names.includes('turn:0:tool_result:0'));
    assert.ok(names.includes('turn:0:assistant-end'));
    assert.ok(names.includes('turn:1:assistant-start'));
    assert.ok(names.includes('turn:1:assistant-end'));

    const start0 = log.find((e) => e.name === 'turn:0:assistant-start');
    assert.equal((start0!.payload as { userPrompt?: string }).userPrompt, 'list the files then finish');
    const end0 = log.find((e) => e.name === 'turn:0:assistant-end');
    assert.equal((end0!.payload as { stopReason?: string }).stopReason, 'tool_use');
    assert.ok(Array.isArray((end0!.payload as { historyDelta?: unknown[] }).historyDelta));

    recordedLog = log;
  });

  it('replays the recorded run with ZERO upstream fetches and ZERO tool executions', async () => {
    // Build the replay seed from test 1's effect log.
    const seed: Record<string, unknown> = {};
    for (const e of recordedLog) seed[e.name] = e.payload;

    let replayFetchCount = 0;
    globalThis.fetch = (async () => { replayFetchCount += 1; return ollamaText('SHOULD NOT RUN'); }) as typeof fetch;
    const fx = new FakeExecutor({ list: () => { throw new Error('tool exec must NOT run on replay'); } });
    const { runtime } = fakeRuntime(seed);
    const recorder = new TurnRecorder({ runtime, partialSink: () => {}, runId: 'run-oll', stepId: 'build' });

    const r = await new OllamaAdapter().run(
      { ...baseConfig, toolExecutor: fx, turnRecorder: recorder },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(replayFetchCount, 0, 'replay must NOT hit the upstream');
    assert.equal(fx.calls.length, 0, 'replay must NOT re-execute tools');
    assert.equal(r.output, 'done', 'replay reproduces the recorded output byte-for-byte');
  });
});
