/**
 * Phase 6 — verify OllamaAdapter routes through the local executor when
 * `config.exclusiveSlot === true`, and bypasses it otherwise.
 *
 * Mocks `globalThis.fetch` to return a tiny NDJSON stream so the adapter
 * runs end-to-end without contacting Ollama. Each test uses a fresh
 * LocalExecutor for isolation.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { OllamaAdapter } from '../ollama-adapter.js';
import { LocalExecutor } from '../router/local-executor.js';
import type { ModelAdapterConfig } from '../types.js';

// Helper: compose an NDJSON stream Ollama-style.
function makeOllamaResponse(text: string): Response {
  const lines = [
    JSON.stringify({ message: { content: text } }),
    JSON.stringify({ done: true, prompt_eval_count: 1, eval_count: 1, total_duration: 1_000_000 }),
  ];
  const body = lines.join('\n') + '\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

class StubWritable {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }
  end(): void { /* noop */ }
  on(): void { /* noop */ }
}

const baseConfig: ModelAdapterConfig = {
  userPrompt: 'hello',
  model: 'qwen2.5-coder:7b',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'developer',
};

let originalFetch: typeof fetch;

before(() => { originalFetch = globalThis.fetch; });
after(() => { globalThis.fetch = originalFetch; });
beforeEach(() => { /* tests reset fetch as needed */ });

describe('OllamaAdapter — exclusiveSlot routing', () => {
  it('does NOT touch the executor when exclusiveSlot is unset', async () => {
    globalThis.fetch = (async () => makeOllamaResponse('hi')) as typeof fetch;
    const exec = new LocalExecutor({ evict: async () => { /* noop */ } });
    const adapter = new OllamaAdapter(exec);

    await adapter.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream);

    assert.equal(exec.inspect().loaded, null, 'executor must remain idle');
    assert.equal(exec.inspect().queueDepth, 0);
  });

  it('routes through the executor when exclusiveSlot is true', async () => {
    globalThis.fetch = (async () => makeOllamaResponse('hi')) as typeof fetch;
    const exec = new LocalExecutor({ evict: async () => { /* noop */ } });
    const adapter = new OllamaAdapter(exec);

    await adapter.run(
      { ...baseConfig, exclusiveSlot: true },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.equal(exec.inspect().loaded, 'qwen2.5-coder:7b');
  });

  it('serializes parallel exclusiveSlot calls (FIFO)', async () => {
    const callOrder: string[] = [];
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      const id = ++fetchCount;
      callOrder.push(`fetch-${id}-start`);
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(`fetch-${id}-end`);
      return makeOllamaResponse(`r${id}`);
    }) as typeof fetch;

    const exec = new LocalExecutor({ evict: async () => { /* noop */ } });
    const adapter = new OllamaAdapter(exec);

    const p1 = adapter.run(
      { ...baseConfig, model: 'qwen2.5-coder:7b', exclusiveSlot: true },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );
    const p2 = adapter.run(
      { ...baseConfig, model: 'qwen2.5-coder:7b', exclusiveSlot: true },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    await Promise.all([p1, p2]);

    // Strict serialization → no interleaving of starts.
    assert.deepEqual(callOrder, [
      'fetch-1-start',
      'fetch-1-end',
      'fetch-2-start',
      'fetch-2-end',
    ]);
  });

  it('triggers eviction when switching models under exclusiveSlot', async () => {
    globalThis.fetch = (async () => makeOllamaResponse('hi')) as typeof fetch;

    const evictions: string[] = [];
    const exec = new LocalExecutor({ evict: async (id) => { evictions.push(id); } });
    const adapter = new OllamaAdapter(exec);

    await adapter.run(
      { ...baseConfig, model: 'qwen2.5-coder:7b', exclusiveSlot: true },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );
    await adapter.run(
      { ...baseConfig, model: 'gemma3:4b', exclusiveSlot: true },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );

    assert.deepEqual(evictions, ['qwen2.5-coder:7b']);
    assert.equal(exec.inspect().loaded, 'gemma3:4b');
  });
});
