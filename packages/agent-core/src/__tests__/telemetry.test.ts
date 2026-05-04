/**
 * Phase 2 telemetry tests — assert that instrumented adapters emit spans
 * with the expected GenAI semantic-convention attributes.
 *
 * The strategy:
 *   1. Reset the agent-core tracer (so it'll re-resolve `trace.getTracer`)
 *   2. Register a test-local NodeTracerProvider with InMemorySpanExporter
 *   3. Run the instrumented adapter against a fake ModelAdapter
 *   4. forceFlush() and read spans out of the exporter
 *   5. Assert attributes
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

import { instrumentModelAdapter } from '../telemetry/instrument.js';
import { resetTracer } from '../telemetry/tracer.js';
import { GenAi } from '../telemetry/attributes.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderName,
  ProviderCapabilities,
} from '../types.js';

// ── Test-local OTel provider + exporter ────────────────────────────────────

let exporter: InMemorySpanExporter;
let provider: NodeTracerProvider;

async function installInMemoryExporter(): Promise<void> {
  await resetTracer();
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'anvil-agent-core-test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
}

async function uninstallInMemoryExporter(): Promise<void> {
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } catch {}
  exporter.reset();
  trace.disable();
}

async function getEmittedSpans(): Promise<ReadableSpan[]> {
  await provider.forceFlush();
  return exporter.getFinishedSpans();
}

// ── Fake adapter ───────────────────────────────────────────────────────────

class FakeAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'claude';
  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: true,
    promptCaching: true,
  };
  constructor(private readonly behavior: 'ok' | 'throw' = 'ok') {}
  supportsModel(_modelId: string): boolean { return true; }
  getModelPricing(_modelId: string): [number, number] | null { return [3, 15]; }
  async checkAvailability(): Promise<{ available: boolean }> { return { available: true }; }
  async run(config: ModelAdapterConfig, _output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    if (this.behavior === 'throw') {
      throw new Error('boom');
    }
    return {
      output: 'fake output',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.0105,
      durationMs: 42,
      sessionId: 'sess-abc',
      provider: this.provider,
      model: config.model,
    };
  }
}

const NULL_STREAM = new Writable({ write(_c, _e, cb) { cb(); } });

const BASE_CONFIG: ModelAdapterConfig = {
  userPrompt: 'hello world',
  projectPrompt: undefined,
  model: 'claude-sonnet-4-6',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
  allowedTools: ['Read', 'Edit', 'Bash'],
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('telemetry — instrumentModelAdapter', () => {
  beforeEach(installInMemoryExporter);
  afterEach(uninstallInMemoryExporter);
  afterEach(() => {
    delete process.env.ANVIL_OTEL_RECORD_CONTENT;
  });

  it('emits a span with GenAI request + response attributes on success', async () => {
    const wrapped = instrumentModelAdapter(new FakeAdapter('ok'));
    const result = await wrapped.run(BASE_CONFIG, NULL_STREAM);
    assert.equal(result.output, 'fake output');

    const spans = await getEmittedSpans();
    assert.equal(spans.length, 1);
    const s = spans[0];
    assert.equal(s.name, 'gen_ai.invoke');
    assert.equal(s.attributes[GenAi.SYSTEM], 'claude');
    assert.equal(s.attributes[GenAi.REQUEST_MODEL], 'claude-sonnet-4-6');
    assert.equal(s.attributes[GenAi.USAGE_INPUT_TOKENS], 1000);
    assert.equal(s.attributes[GenAi.USAGE_OUTPUT_TOKENS], 500);
    // Phase 4 wrapper recomputes cost from the central table for known models.
    // FP rounding means 0.003 + 0.0075 ≈ 0.010499999999999999 — assert within ε.
    assert.ok(
      Math.abs((s.attributes[GenAi.USAGE_COST_USD] as number) - 0.0105) < 1e-9,
      `expected cost ≈ 0.0105, got ${s.attributes[GenAi.USAGE_COST_USD]}`,
    );
    assert.equal(s.attributes[GenAi.RESPONSE_ID], 'sess-abc');
    assert.equal(s.attributes['anvil.stage'], 'build');
    assert.equal(s.attributes['anvil.persona'], 'engineer');
    assert.equal(s.attributes[GenAi.TOOLS_COUNT], 3);
    assert.equal(s.status.code, 1); // OK
  });

  it('does NOT include prompt/completion text by default', async () => {
    const wrapped = instrumentModelAdapter(new FakeAdapter('ok'));
    await wrapped.run(BASE_CONFIG, NULL_STREAM);

    const spans = await getEmittedSpans();
    const attrs = spans[0].attributes;
    assert.equal(attrs[GenAi.PROMPT], undefined);
    assert.equal(attrs[GenAi.COMPLETION], undefined);
  });

  it('records prompt and completion when ANVIL_OTEL_RECORD_CONTENT=1', async () => {
    process.env.ANVIL_OTEL_RECORD_CONTENT = '1';
    const wrapped = instrumentModelAdapter(new FakeAdapter('ok'));
    await wrapped.run(BASE_CONFIG, NULL_STREAM);

    const spans = await getEmittedSpans();
    const attrs = spans[0].attributes;
    assert.equal(attrs[GenAi.PROMPT], 'hello world');
    assert.equal(attrs[GenAi.COMPLETION], 'fake output');
  });

  it('sets ERROR status and records exception when adapter throws', async () => {
    const wrapped = instrumentModelAdapter(new FakeAdapter('throw'));
    await assert.rejects(() => wrapped.run(BASE_CONFIG, NULL_STREAM), /boom/);

    const spans = await getEmittedSpans();
    assert.equal(spans.length, 1);
    const s = spans[0];
    assert.equal(s.status.code, 2); // ERROR
    assert.match(s.status.message ?? '', /boom/);
    assert.ok(s.events.length >= 1, 'expected an exception event recorded');
    const exEvent = s.events.find((e) => e.name === 'exception');
    assert.ok(exEvent, 'expected exception event');
  });

  it('preserves all delegating ModelAdapter methods', async () => {
    const inner = new FakeAdapter('ok');
    const wrapped = instrumentModelAdapter(inner);
    assert.equal(wrapped.provider, 'claude');
    assert.equal(wrapped.capabilities.tier, 'agentic');
    assert.equal(wrapped.supportsModel('any'), true);
    assert.deepEqual(wrapped.getModelPricing('any'), [3, 15]);
    const avail = await wrapped.checkAvailability();
    assert.equal(avail.available, true);
  });
});
