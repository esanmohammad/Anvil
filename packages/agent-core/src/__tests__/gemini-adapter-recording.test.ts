/**
 * §H4 — cross-vendor turn recording for the Gemini single-shot adapter.
 *
 * Verifies the adapter (a) records `turn:0:assistant-start` with the
 * user prompt and `turn:0:assistant-end` with the streamed text on the
 * live path, and (b) honors a recorded turn on replay by skipping the
 * upstream fetch entirely. Mocks `globalThis.fetch` with a fake Gemini
 * SSE stream; the recorder runs over a test-double EffectRuntime.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { GeminiAdapter } from '../gemini-adapter.js';
import { TurnRecorder } from '../turn-recorder/index.js';
import type { EffectRuntimeLike, EffectInvokeOptions } from '../turn-recorder/types.js';
import type { ModelAdapterConfig } from '../types.js';

function geminiSse(text: string): Response {
  const body =
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n` +
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: '' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    })}\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

class StubWritable {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }
  end(): void {}
  on(): void {}
}

interface Logged { name: string; opts?: EffectInvokeOptions; payload?: unknown }

/** EffectRuntime double; `seed[name]` makes peekRecorded return a replay. */
function fakeRuntime(seed: Record<string, unknown> = {}): { runtime: EffectRuntimeLike; log: Logged[] } {
  const log: Logged[] = [];
  const runtime: EffectRuntimeLike = {
    async effect<T>(name: string, fn: () => Promise<T>, opts?: EffectInvokeOptions): Promise<T> {
      if (name in seed) {
        log.push({ name, opts, payload: seed[name] });
        return seed[name] as T;
      }
      const payload = await fn();
      log.push({ name, opts, payload });
      return payload;
    },
    peekRecorded<T = unknown>(name: string): T | undefined {
      return (name in seed ? seed[name] : undefined) as T | undefined;
    },
  };
  return { runtime, log };
}

const baseConfig: ModelAdapterConfig = {
  userPrompt: 'summarise the repo',
  model: 'gemini-2.5-flash',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
  sessionId: 'run-gem',
};

let originalFetch: typeof fetch;
let originalKey: string | undefined;
before(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;
});

describe('GeminiAdapter — H4 turn recording', () => {
  it('records assistant-start (with userPrompt) and assistant-end (with text) on the live path', async () => {
    globalThis.fetch = (async () => geminiSse('hello from gemini')) as typeof fetch;
    const { runtime, log } = fakeRuntime();
    const recorder = new TurnRecorder({ runtime, partialSink: () => {}, runId: 'run-gem', stepId: 'build' });

    const r = await new GeminiAdapter().run(
      { ...baseConfig, turnRecorder: recorder },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(r.output, 'hello from gemini');

    const start = log.find((e) => e.name === 'turn:0:assistant-start');
    assert.ok(start, 'assistant-start must be recorded');
    assert.equal((start!.payload as { userPrompt?: string }).userPrompt, 'summarise the repo');

    const end = log.find((e) => e.name === 'turn:0:assistant-end');
    assert.ok(end, 'assistant-end must be recorded');
    assert.equal((end!.payload as { text?: string }).text, 'hello from gemini');
    assert.equal((end!.payload as { provider?: string }).provider, 'gemini');
  });

  it('skips the upstream fetch on replay and returns the recorded turn', async () => {
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return geminiSse('SHOULD NOT RUN'); }) as typeof fetch;

    // Seed a recorded assistant-end → startTurn returns `replayed`.
    const { runtime } = fakeRuntime({
      'turn:0:assistant-end': {
        text: 'recorded answer',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
        provenance: { segments: [{ model: 'gemini-2.5-flash', provider: 'gemini', range: [0, 15], source: 'live' }] },
        historyDelta: [],
      },
    });
    const recorder = new TurnRecorder({ runtime, partialSink: () => {}, runId: 'run-gem', stepId: 'build' });

    const r = await new GeminiAdapter().run(
      { ...baseConfig, turnRecorder: recorder },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(fetched, false, 'replay must NOT hit the upstream');
    assert.equal(r.output, 'recorded answer');
    assert.equal(r.inputTokens, 10);
    assert.equal(r.outputTokens, 5);
  });
});
