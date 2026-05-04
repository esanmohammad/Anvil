/**
 * Phase 5 — verify LanguageModelBridge constructs a BuiltinToolExecutor
 * for non-Claude providers from request.allowedTools, and threads the
 * model's context_window through ModelAdapterConfig.
 *
 * Stubs a minimal ModelAdapter that captures the config it receives so
 * we can assert what the bridge plumbed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageModelBridge, _resetBridgeRegistryCache } from '../language-model-bridge.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
} from '../../../types.js';
import type { AdapterRequest } from '../adapter.js';

class CapturingAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;
  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: false,
    cache: 'none',
    structuredOutput: 'best-effort',
    maxOutputTokens: false,
  };
  lastConfig: ModelAdapterConfig | null = null;
  supportsModel(): boolean { return true; }
  getModelPricing(): [number, number] | null { return [0, 0]; }
  async checkAvailability(): Promise<{ available: boolean }> { return { available: true }; }
  async run(config: ModelAdapterConfig): Promise<ModelAdapterResult> {
    this.lastConfig = config;
    return {
      output: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
      durationMs: 0, provider: 'ollama', model: config.model,
    };
  }
}

class ClaudeLikeAdapter implements ModelAdapter {
  readonly provider = 'claude' as const;
  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: true,
    cache: 'explicit',
    structuredOutput: 'tool-shim',
    maxOutputTokens: true,
  };
  lastConfig: ModelAdapterConfig | null = null;
  supportsModel(): boolean { return true; }
  getModelPricing(): [number, number] | null { return [3, 15]; }
  async checkAvailability(): Promise<{ available: boolean }> { return { available: true }; }
  async run(config: ModelAdapterConfig): Promise<ModelAdapterResult> {
    this.lastConfig = config;
    return {
      output: '', inputTokens: 0, outputTokens: 0, costUsd: 0,
      durationMs: 0, provider: 'claude', model: config.model,
    };
  }
}

function devNull(): NodeJS.WritableStream {
  return new Writable({ write: (_c, _e, cb) => cb() });
}

function makeRequest(overrides: Partial<AdapterRequest>): AdapterRequest {
  return {
    prompt: 'do thing',
    model: 'qwen3:14b',
    sessionId: 'sess-1',
    cwd: '/tmp',
    stage: 'build',
    ...overrides,
  };
}

describe('LanguageModelBridge — tool executor wiring', () => {
  it('attaches a BuiltinToolExecutor for non-Claude providers', async () => {
    const adapter = new CapturingAdapter();
    const req = makeRequest({ allowedTools: ['read_file', 'bash'] });
    const bridge = new LanguageModelBridge(req, adapter, 'ollama');

    bridge.start();
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(adapter.lastConfig?.toolExecutor, 'tool executor must be present');
    const schemas = adapter.lastConfig.toolExecutor.listSchemas();
    const names = schemas.map((s) => s.name).sort();
    assert.deepEqual(names, ['bash', 'read_file']);
  });

  it('does NOT attach a tool executor for Claude (it ships its own)', async () => {
    const adapter = new ClaudeLikeAdapter();
    const req = makeRequest({ allowedTools: ['bash'] });
    const bridge = new LanguageModelBridge(req, adapter, 'claude');

    bridge.start();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(adapter.lastConfig?.toolExecutor, undefined);
  });

  it('falls back to read-only tools when allowedTools is missing', async () => {
    const adapter = new CapturingAdapter();
    const req = makeRequest({});
    const bridge = new LanguageModelBridge(req, adapter, 'ollama');

    bridge.start();
    await new Promise((r) => setTimeout(r, 30));

    const names = adapter.lastConfig?.toolExecutor?.listSchemas().map((s) => s.name).sort();
    assert.deepEqual(names, ['glob', 'grep', 'list', 'read_file']);
  });

  it('threads exclusiveSlot from request to ModelAdapterConfig', async () => {
    const adapter = new CapturingAdapter();
    const req = makeRequest({ exclusiveSlot: true });
    const bridge = new LanguageModelBridge(req, adapter, 'ollama');

    bridge.start();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(adapter.lastConfig?.exclusiveSlot, true);
  });

  it('threads context_window from the model registry', async () => {
    // Stand up a tmp ANVIL_HOME with a known model registry.
    const home = mkdtempSync(join(tmpdir(), 'anvil-bridge-test-'));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'models.yaml'), [
      'models:',
      '  - id: qwen3:14b',
      '    provider: ollama',
      '    tier: local',
      '    capabilities: [code, reasoning]',
      '    complexity_max: M',
      '    vram_gb: 9',
      '    exclusive_slot: true',
      '    context_window: 12345',
    ].join('\n'));

    const prevHome = process.env.ANVIL_HOME;
    process.env.ANVIL_HOME = home;
    _resetBridgeRegistryCache();

    try {
      const adapter = new CapturingAdapter();
      const req = makeRequest({});
      const bridge = new LanguageModelBridge(req, adapter, 'ollama');

      bridge.start();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(adapter.lastConfig?.contextWindow, 12345);
    } finally {
      if (prevHome === undefined) delete process.env.ANVIL_HOME;
      else process.env.ANVIL_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
      _resetBridgeRegistryCache();
    }
  });
});
