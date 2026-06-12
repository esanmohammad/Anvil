/**
 * Phase 1 — `legacyAdapterToLanguageModel` shim.
 *
 * A fake `ModelAdapter` writes known Anvil Stream Format NDJSON to the sink
 * and resolves a `ModelAdapterResult`. We assert the shim turns that push
 * stream into the pull `LanguageModel` surface correctly: `invokeStream`
 * yields the right `StreamEvent`s, `invoke` assembles the `InvokeResult`, and
 * a rejected `run()` surfaces as a throw the unified classifier understands.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Writable } from 'node:stream';

import { legacyAdapterToLanguageModel } from '../agent/session/legacy-adapter-language-model.js';
import { emitContent, emitToolUse } from '../stream-format.js';
import { UpstreamError } from '../upstream-error.js';
import { classifyError } from '../router/errors.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  StreamEvent,
  LanguageModelInvokeOptions,
} from '../types.js';

type Script = (out: NodeJS.WritableStream) => Promise<ModelAdapterResult>;

class FakeAdapter implements ModelAdapter {
  readonly provider = 'openrouter' as ModelAdapter['provider'];
  readonly capabilities = { streaming: true } as ModelAdapter['capabilities'];
  constructor(private readonly script: Script) {}
  supportsModel(): boolean { return true; }
  getModelPricing(): [number, number] | null { return null; }
  async checkAvailability() { return { available: true }; }
  run(_config: ModelAdapterConfig, output: Writable | NodeJS.WritableStream): Promise<ModelAdapterResult> {
    return this.script(output);
  }
}

const OPTS: LanguageModelInvokeOptions = {
  model: 'some-model',
  messages: [{ role: 'user', content: 'hi' }],
};

function fakeResult(over: Partial<ModelAdapterResult>): ModelAdapterResult {
  return {
    output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0,
    provider: 'openrouter', model: 'some-model', ...over,
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('legacyAdapterToLanguageModel — invoke()', () => {
  it('assembles InvokeResult from streamed text + resolved result', async () => {
    const adapter = new FakeAdapter(async (out) => {
      emitContent(out, 'Hello ');
      emitContent(out, 'world');
      return fakeResult({ output: 'Hello world', inputTokens: 10, outputTokens: 5, costUsd: 0.001, durationMs: 120, stopReason: 'end_turn' });
    });
    const lm = legacyAdapterToLanguageModel(adapter);
    const res = await lm.invoke(OPTS);
    assert.equal(res.text, 'Hello world');
    assert.equal(res.usage.inputTokens, 10);
    assert.equal(res.usage.outputTokens, 5);
    assert.equal(res.costUsd, 0.001);
    assert.equal(res.durationMs, 120);
    assert.equal(res.finishReason, 'end');
    assert.equal(res.provider, 'openrouter');
    assert.deepEqual(res.toolCalls, []);
  });

  it('surfaces tool_use blocks as structured toolCalls + tool-use finish', async () => {
    const adapter = new FakeAdapter(async (out) => {
      emitToolUse(out, 'read_file', { path: 'a.ts' }, 't1');
      return fakeResult({ output: '', stopReason: 'tool_use' });
    });
    const res = await legacyAdapterToLanguageModel(adapter).invoke(OPTS);
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].name, 'read_file');
    assert.equal(res.toolCalls[0].id, 't1');
    assert.deepEqual(res.toolCalls[0].arguments, { path: 'a.ts' });
    assert.equal(res.finishReason, 'tool-use');
  });
});

describe('legacyAdapterToLanguageModel — invokeStream()', () => {
  it('yields text-delta events then usage then finish', async () => {
    const adapter = new FakeAdapter(async (out) => {
      emitContent(out, 'A');
      emitContent(out, 'B');
      return fakeResult({ output: 'AB', inputTokens: 3, outputTokens: 2, stopReason: 'end_turn' });
    });
    const events = await collect(legacyAdapterToLanguageModel(adapter).invokeStream(OPTS));
    const kinds = events.map((e) => e.type);
    assert.deepEqual(kinds, ['text-delta', 'text-delta', 'usage', 'finish']);
    assert.equal((events[0] as { text: string }).text, 'A');
    assert.equal((events[3] as { reason: string }).reason, 'end');
  });
});

describe('legacyAdapterToLanguageModel — error propagation', () => {
  it('rethrows a rejected run() so the unified classifier can act on it', async () => {
    const adapter = new FakeAdapter(async () => {
      throw new UpstreamError(0, 'fetch failed: fetch failed', { provider: 'opencode', retryable: true });
    });
    await assert.rejects(
      () => legacyAdapterToLanguageModel(adapter).invoke(OPTS),
      (err: unknown) => {
        assert.equal(classifyError(err), 'timeout');
        return true;
      },
    );
  });
});
