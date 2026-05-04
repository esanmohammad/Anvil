/**
 * Phase 4 tests — cost breakdown + per-component span annotation.
 *
 * Covers:
 *   - calculateCostBreakdown returns 5 fields, components sum to total (within ε)
 *   - Wrapper emits gen_ai.usage.cost_{input,output,cache_read,cache_write}_usd
 *   - Unknown-model fallback: wrapper preserves adapter's costUsd when the
 *     central table doesn't know the model (no fabricated zero on the total)
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

import { calculateCostBreakdown } from '../cost.js';
import { instrumentModelAdapter } from '../telemetry/instrument.js';
import { resetTracer } from '../telemetry/tracer.js';
import { GenAi } from '../telemetry/attributes.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ProviderName,
  ProviderCapabilities,
} from '../types.js';

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
  model: 'claude-sonnet-4-6',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
};

const CAPS: ProviderCapabilities = {
  tier: 'agentic',
  streaming: true,
  toolUse: true,
  fileSystem: true,
  shellExecution: true,
  sessionResume: true,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Phase 4 — cost breakdown', () => {
  it('calculateCostBreakdown returns components that sum to total', () => {
    const bd = calculateCostBreakdown('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 50_000,
    });
    // sonnet-4-6: input=$3/1M, output=$15/1M, cache_read=$0.30/1M, cache_write=$3.75/1M
    assert.equal(bd.inputUsd, 3.0);
    assert.equal(bd.outputUsd, 7.5);
    // cache values are non-zero for Anthropic flagship models
    assert.ok(bd.cacheReadUsd > 0, 'expected non-zero cache_read cost');
    assert.ok(bd.cacheWriteUsd > 0, 'expected non-zero cache_write cost');
    // total = sum, within FP epsilon
    const sum = bd.inputUsd + bd.outputUsd + bd.cacheReadUsd + bd.cacheWriteUsd;
    assert.ok(Math.abs(bd.totalUsd - sum) < 1e-9);
  });

  it('returns all-zero breakdown for an unknown model', () => {
    const bd = calculateCostBreakdown('nonexistent-model-xyz', {
      inputTokens: 1000,
      outputTokens: 500,
    });
    assert.equal(bd.totalUsd, 0);
    assert.equal(bd.inputUsd, 0);
    assert.equal(bd.outputUsd, 0);
    assert.equal(bd.cacheReadUsd, 0);
    assert.equal(bd.cacheWriteUsd, 0);
  });
});

describe('Phase 4 — span emits per-component cost attrs', () => {
  beforeEach(installExporter);
  afterEach(uninstallExporter);

  it('emits cost_input/output/cache_read/cache_write for a known model', async () => {
    const adapter: ModelAdapter = {
      provider: 'claude' as ProviderName,
      capabilities: CAPS,
      supportsModel: () => true,
      getModelPricing: () => [3, 15],
      checkAvailability: async () => ({ available: true }),
      async run() {
        return {
          output: 'x',
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 200_000,
          cacheWriteTokens: 100_000,
          costUsd: 99, // legacy adapter-supplied number — should be replaced
          durationMs: 10,
          provider: 'claude',
          model: 'claude-sonnet-4-6',
        };
      },
    };
    const wrapped = instrumentModelAdapter(adapter);
    await wrapped.run(BASE_CONFIG, NULL_STREAM);

    const spans = await getSpans();
    const a = spans[0].attributes;
    // cost_usd is REPLACED with breakdown total (cost-table wins per O6)
    assert.notEqual(a[GenAi.USAGE_COST_USD], 99);
    assert.ok((a[GenAi.USAGE_COST_USD] as number) > 0);
    // five cost-component attrs all present
    assert.equal(a[GenAi.USAGE_COST_INPUT_USD], 3.0);
    assert.equal(a[GenAi.USAGE_COST_OUTPUT_USD], 7.5);
    assert.ok(typeof a[GenAi.USAGE_COST_CACHE_READ_USD] === 'number');
    assert.ok(typeof a[GenAi.USAGE_COST_CACHE_WRITE_USD] === 'number');
    assert.ok((a[GenAi.USAGE_COST_CACHE_READ_USD] as number) > 0);
    assert.ok((a[GenAi.USAGE_COST_CACHE_WRITE_USD] as number) > 0);
  });

  it('falls back to adapter costUsd when cost-table does not know the model', async () => {
    const adapter: ModelAdapter = {
      provider: 'claude' as ProviderName,
      capabilities: CAPS,
      supportsModel: () => true,
      getModelPricing: () => null,
      checkAvailability: async () => ({ available: true }),
      async run() {
        return {
          output: 'x',
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 0.1234,
          durationMs: 10,
          provider: 'claude',
          model: 'totally-unknown-model-ZZZ',
        };
      },
    };
    const wrapped = instrumentModelAdapter(adapter);
    await wrapped.run({ ...BASE_CONFIG, model: 'totally-unknown-model-ZZZ' }, NULL_STREAM);

    const spans = await getSpans();
    const a = spans[0].attributes;
    // Total falls back to adapter's costUsd (don't undercount on unknown models)
    assert.equal(a[GenAi.USAGE_COST_USD], 0.1234);
    // Components are zero (cost table doesn't know)
    assert.equal(a[GenAi.USAGE_COST_INPUT_USD], 0);
    assert.equal(a[GenAi.USAGE_COST_OUTPUT_USD], 0);
  });
});
