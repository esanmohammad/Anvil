/**
 * Phase 6 integration tests — exercise full single-shot + adapter paths
 * with telemetry enabled and assert on captured spans.
 *
 * These tests bridge the per-component unit tests (Phase 2/3/4) with
 * end-to-end behaviour:
 *   - runClaude in CLI mode → fake claude script → withInvokeSpan path
 *   - Default (no env vars) → no spans exported (noop tracer)
 *   - ANVIL_OTEL_DISABLED=1 → kill-switch wins even when OTLP endpoint set
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { resetTracer, loadTelemetryConfig } from '../telemetry/index.js';
import { GenAi } from '../telemetry/attributes.js';

// ── Test scaffolding ──────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = join(tmpdir(), `anvil-otel-int-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFakeClaude(dir: string): string {
  const resultLine = JSON.stringify({
    type: 'result',
    result: 'integration ok',
    total_cost_usd: 0.0042,
    usage: { input_tokens: 1234, output_tokens: 567 },
    duration_ms: 100,
  });
  const script = `#!/bin/bash\necho '${resultLine}'\n`;
  const path = join(dir, 'fake-claude');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Phase 6 integration — runClaude (cli mode) with telemetry', () => {
  beforeEach(installExporter);
  afterEach(uninstallExporter);

  it('emits a gen_ai.invoke span with full attribute set', async () => {
    const tmp = createTempDir();
    const fakeBin = createFakeClaude(tmp);

    // Set env BEFORE dynamic import so claude-runner config picks it up.
    process.env.ANVIL_CLAUDE_BIN = fakeBin;
    process.env.ANVIL_LLM_MODE = 'cli';
    process.env.ANVIL_LLM_MODEL = 'claude-sonnet-4-6';
    delete process.env.ANVIL_LLM_API_KEY;

    try {
      const ssMod = await import(`../single-shot.js?cb=${Date.now()}`);
      ssMod.resetLlmConfig();
      const result = await ssMod.runClaude('hello', 'be helpful', {
        model: 'claude-sonnet-4-6',
      });

      assert.equal(result.result, 'integration ok');
      assert.equal(result.inputTokens, 1234);
      assert.equal(result.outputTokens, 567);

      const spans = await getSpans();
      assert.equal(spans.length, 1);
      const a = spans[0].attributes;
      assert.equal(a[GenAi.SYSTEM], 'claude');
      assert.equal(a[GenAi.REQUEST_MODEL], 'claude-sonnet-4-6');
      assert.equal(a[GenAi.USAGE_INPUT_TOKENS], 1234);
      assert.equal(a[GenAi.USAGE_OUTPUT_TOKENS], 567);
      // Cost from central table (sonnet-4-6: $3/$15) overrides 0.0042
      const cost = a[GenAi.USAGE_COST_USD] as number;
      assert.ok(cost > 0, 'expected cost from central table');
      // Components present
      assert.ok(typeof a[GenAi.USAGE_COST_INPUT_USD] === 'number');
      assert.ok(typeof a[GenAi.USAGE_COST_OUTPUT_USD] === 'number');
      // Anvil extension
      assert.equal(a['anvil.transport'], 'cli');
      assert.equal(spans[0].status.code, 1); // OK
    } finally {
      delete process.env.ANVIL_CLAUDE_BIN;
      delete process.env.ANVIL_LLM_MODE;
      delete process.env.ANVIL_LLM_MODEL;
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('Phase 6 integration — config kill-switches', () => {
  it('default (no env vars) resolves to noop / disabled', () => {
    delete process.env.ANVIL_OTEL_CONSOLE;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.ANVIL_OTEL_DISABLED;
    const cfg = loadTelemetryConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.exporterMode, 'noop');
  });

  it('ANVIL_OTEL_DISABLED=1 wins over OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    process.env.ANVIL_OTEL_DISABLED = '1';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://example.com:4318/v1/traces';
    try {
      const cfg = loadTelemetryConfig();
      assert.equal(cfg.enabled, false);
      assert.equal(cfg.exporterMode, 'noop');
    } finally {
      delete process.env.ANVIL_OTEL_DISABLED;
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });

  it('OTEL_EXPORTER_OTLP_ENDPOINT alone enables otlp mode', () => {
    delete process.env.ANVIL_OTEL_DISABLED;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces';
    try {
      const cfg = loadTelemetryConfig();
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.exporterMode, 'otlp');
      assert.equal(cfg.endpoint, 'http://localhost:4318/v1/traces');
    } finally {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });
});
