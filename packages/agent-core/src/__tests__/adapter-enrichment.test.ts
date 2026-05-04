/**
 * Phase 3 tests — verify per-adapter telemetry enrichment.
 *
 * Each adapter is stubbed with a captured-fixture-style provider response;
 * we assert that ModelAdapterResult surfaces the cache + reasoning + tool
 * fields in the normalized agent-core shape.
 *
 * Fixtures are inlined (not files) to keep the test self-contained and
 * to make the response shape obvious next to the assertion.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { OpenAIAdapter } from '../openai-adapter.js';
import { GeminiAdapter } from '../gemini-adapter.js';
import { instrumentModelAdapter } from '../telemetry/instrument.js';
import { resetTracer } from '../telemetry/tracer.js';
import { GenAi } from '../telemetry/attributes.js';
import type { ModelAdapterConfig } from '../types.js';

// ── In-memory exporter scaffold ────────────────────────────────────────────

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

async function installExporter(): Promise<void> {
  await resetTracer();
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'anvil-agent-core-test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
}

async function uninstallExporter(): Promise<void> {
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } catch {}
  exporter.reset();
  trace.disable();
}

async function getSpans(): Promise<ReadableSpan[]> {
  await provider.forceFlush();
  return exporter.getFinishedSpans();
}

const NULL_STREAM = new Writable({ write(_c, _e, cb) { cb(); } });

const BASE_CONFIG: ModelAdapterConfig = {
  userPrompt: 'hello',
  model: 'gpt-4o',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
};

// ── Fake fetch helper ──────────────────────────────────────────────────────

function makeFakeFetch(sseLines: string[]): typeof fetch {
  return async (_url: any, _init?: any): Promise<Response> => {
    const body = sseLines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Phase 3 — per-adapter enrichment', () => {
  beforeEach(installExporter);
  afterEach(uninstallExporter);

  it('OpenAI adapter surfaces cached_tokens and reasoning_tokens', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    // Captured-shape fixture: an o3-mini chat.completions stream that uses
    // prompt cache + reasoning. Schema mirrors real OpenAI responses.
    globalThis.fetch = makeFakeFetch([
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      JSON.stringify({
        choices: [{ delta: {} }],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 800,
          prompt_tokens_details: { cached_tokens: 1200 },
          completion_tokens_details: { reasoning_tokens: 600 },
        },
      }),
    ]);

    try {
      const adapter = instrumentModelAdapter(new OpenAIAdapter());
      const result = await adapter.run({ ...BASE_CONFIG, model: 'o3-mini' }, NULL_STREAM);

      assert.equal(result.inputTokens, 1500);
      assert.equal(result.outputTokens, 800);
      assert.equal(result.cacheReadTokens, 1200);
      assert.equal(result.reasoningTokens, 600);
      assert.equal(result.cacheWriteTokens, undefined); // OpenAI does not bill writes

      const spans = await getSpans();
      assert.equal(spans.length, 1);
      const a = spans[0].attributes;
      assert.equal(a[GenAi.USAGE_CACHE_READ_TOKENS], 1200);
      assert.equal(a[GenAi.REASONING_TOKENS], 600);
      // hit ratio = 1200 / (1500 + 1200) = 0.4444…
      assert.ok(typeof a[GenAi.USAGE_CACHE_HIT_RATIO] === 'number');
      const ratio = a[GenAi.USAGE_CACHE_HIT_RATIO] as number;
      assert.ok(ratio > 0.44 && ratio < 0.45);
      // cache_write should not be present (adapter didn't surface it)
      assert.equal(a[GenAi.USAGE_CACHE_WRITE_TOKENS], undefined);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it('Gemini adapter surfaces cachedContentTokenCount and thoughtsTokenCount', async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';

    // Gemini SSE shape: candidates + usageMetadata. Final chunk carries
    // cumulative usage including cachedContentTokenCount and thoughtsTokenCount.
    globalThis.fetch = makeFakeFetch([
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hi ' }] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 5 },
      }),
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'there' }] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 700,
          thoughtsTokenCount: 200,
        },
      }),
    ]);

    try {
      const adapter = instrumentModelAdapter(new GeminiAdapter());
      const result = await adapter.run({ ...BASE_CONFIG, model: 'gemini-2.5-pro' }, NULL_STREAM);

      assert.equal(result.inputTokens, 1000);
      assert.equal(result.outputTokens, 50);
      assert.equal(result.cacheReadTokens, 700);
      assert.equal(result.reasoningTokens, 200);

      const spans = await getSpans();
      const a = spans[0].attributes;
      assert.equal(a[GenAi.USAGE_CACHE_READ_TOKENS], 700);
      assert.equal(a[GenAi.REASONING_TOKENS], 200);
      // hit ratio = 700 / (1000 + 700) ≈ 0.4118
      const ratio = a[GenAi.USAGE_CACHE_HIT_RATIO] as number;
      assert.ok(ratio > 0.41 && ratio < 0.42);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it('omits cache attrs entirely when adapter does not surface them', async () => {
    // A minimal fake that returns no cache fields — verifies the wrapper
    // doesn't fabricate zero values when the data is genuinely absent.
    const fake = instrumentModelAdapter({
      provider: 'claude' as const,
      capabilities: {
        tier: 'agentic' as const,
        streaming: true,
        toolUse: true,
        fileSystem: true,
        shellExecution: true,
        sessionResume: true,
      },
      supportsModel: () => true,
      getModelPricing: () => null,
      checkAvailability: async () => ({ available: true }),
      async run() {
        return {
          output: 'x',
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
          durationMs: 10,
          provider: 'claude' as const,
          model: 'sonnet',
        };
      },
    });

    await fake.run(BASE_CONFIG, NULL_STREAM);
    const spans = await getSpans();
    const a = spans[0].attributes;
    assert.equal(a[GenAi.USAGE_CACHE_READ_TOKENS], undefined);
    assert.equal(a[GenAi.USAGE_CACHE_WRITE_TOKENS], undefined);
    assert.equal(a[GenAi.USAGE_CACHE_HIT_RATIO], undefined);
    assert.equal(a[GenAi.REASONING_TOKENS], undefined);
  });
});
