/**
 * STAGE_OUTPUT_LIMITS table + LanguageModelBridge round-trip checks.
 *
 * The adapter-internals slice of this test (max_tokens body, finish_reason
 * normalization, claude stop_reason capture) lives in agent-core now —
 * `packages/agent-core/src/__tests__/openai-adapter-output.test.ts` and
 * adapter-enrichment.test.ts. Phase 1 of the dashboard consolidation moved
 * those concerns out of dashboard's local adapters.
 *
 * What stays here:
 *   - STAGE_OUTPUT_LIMITS coverage of every pipeline stage (orthogonal to
 *     adapter migration).
 *   - Bridge-level checks that prove the dashboard's `BaseAdapter` contract
 *     still works once `createAdapter()` returns an `LanguageModelBridge`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_OUTPUT_LIMITS,
  STAGE_OUTPUT_LIMIT_FALLBACK,
  maxOutputTokensForStage,
  listStageNames,
} from '../pipeline-runner.js';
import {
  LanguageModelBridge,
  type AdapterCostInfo,
  type ModelAdapter,
  type ModelAdapterConfig,
  type ModelAdapterResult,
  type ProviderCapabilities,
} from '@anvil/agent-core';

// ── STAGE_OUTPUT_LIMITS table ─────────────────────────────────────────────

describe('STAGE_OUTPUT_LIMITS', () => {
  it('covers every pipeline stage', () => {
    for (const name of listStageNames()) {
      assert.ok(
        STAGE_OUTPUT_LIMITS[name] !== undefined,
        `STAGE_OUTPUT_LIMITS missing entry for ${name}`,
      );
    }
  });

  it('uses positive integer ceilings', () => {
    for (const [name, limit] of Object.entries(STAGE_OUTPUT_LIMITS)) {
      assert.equal(Number.isInteger(limit), true, `${name} limit must be integer`);
      assert.ok(limit > 0, `${name} limit must be positive`);
    }
  });

  it('build has the largest ceiling (codegen needs the headroom)', () => {
    const build = STAGE_OUTPUT_LIMITS.build;
    for (const [name, limit] of Object.entries(STAGE_OUTPUT_LIMITS)) {
      if (name === 'build') continue;
      assert.ok(limit <= build, `${name} (${limit}) should not exceed build (${build})`);
    }
  });

  it('maxOutputTokensForStage returns table values + fallback for unknowns', () => {
    assert.equal(maxOutputTokensForStage('build'), STAGE_OUTPUT_LIMITS.build);
    assert.equal(maxOutputTokensForStage('clarify'), STAGE_OUTPUT_LIMITS.clarify);
    assert.equal(maxOutputTokensForStage('not-a-real-stage'), STAGE_OUTPUT_LIMIT_FALLBACK);
  });
});

// ── LanguageModelBridge contract ──────────────────────────────────────────────

/** Minimal in-memory ModelAdapter that records the config it was called with. */
class FakeModelAdapter implements ModelAdapter {
  readonly provider = 'claude' as const;
  readonly capabilities: ProviderCapabilities;
  lastConfig: ModelAdapterConfig | null = null;
  result: ModelAdapterResult;

  constructor(opts: {
    capabilities: ProviderCapabilities;
    result: ModelAdapterResult;
    streamLines?: string[];
  }) {
    this.capabilities = opts.capabilities;
    this.result = opts.result;
    this.streamLines = opts.streamLines ?? [];
  }

  private streamLines: string[];

  supportsModel(): boolean {
    return true;
  }

  getModelPricing(): [number, number] | null {
    return null;
  }

  async checkAvailability(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    this.lastConfig = config;
    for (const line of this.streamLines) output.write(line + '\n');
    return this.result;
  }
}

describe('LanguageModelBridge', () => {
  it('forwards setMaxOutputTokens to the wrapped adapter via run() config', async () => {
    const fake = new FakeModelAdapter({
      capabilities: { tier: 'function-calling', streaming: true, toolUse: true, fileSystem: false, shellExecution: false, sessionResume: false, maxOutputTokens: true },
      result: { output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, provider: 'openai', model: 'gpt-4o-mini' },
    });
    const bridge = new LanguageModelBridge(
      { prompt: 'hi', model: 'gpt-4o-mini', sessionId: 's1', cwd: process.cwd() },
      fake,
      'openai',
    );
    bridge.setMaxOutputTokens(1234);

    await new Promise<void>((resolve) => {
      bridge.on('exit', () => resolve());
      bridge.start();
    });

    assert.equal(fake.lastConfig?.maxOutputTokens, 1234);
  });

  it('surfaces stopReason from ModelAdapterResult onto the dashboard cost shape', async () => {
    const fake = new FakeModelAdapter({
      capabilities: { tier: 'function-calling', streaming: true, toolUse: true, fileSystem: false, shellExecution: false, sessionResume: false, maxOutputTokens: true },
      result: {
        output: 'truncated body',
        inputTokens: 10,
        outputTokens: 16000,
        costUsd: 0,
        durationMs: 12,
        provider: 'openai',
        model: 'gpt-4o-mini',
        stopReason: 'max_tokens',
      },
    });
    const bridge = new LanguageModelBridge(
      { prompt: 'hi', model: 'gpt-4o-mini', sessionId: 's2', cwd: process.cwd() },
      fake,
      'openai',
    );

    const captured: { cost: AdapterCostInfo | null } = { cost: null };
    await new Promise<void>((resolve) => {
      bridge.on('result', (data) => { captured.cost = data.cost; });
      bridge.on('exit', () => resolve());
      bridge.start();
    });

    assert.ok(captured.cost, 'result event should fire');
    assert.equal(captured.cost!.stopReason, 'max_tokens');
    assert.equal(captured.cost!.outputTokens, 16000);
  });

  it("maps capabilities.cache='explicit' to AdapterCapabilities.promptCache='explicit'", () => {
    const fake = new FakeModelAdapter({
      capabilities: { tier: 'agentic', streaming: true, toolUse: true, fileSystem: true, shellExecution: true, sessionResume: true, cache: 'explicit', cacheTtlSeconds: 300, structuredOutput: 'tool-shim', maxOutputTokens: false },
      result: { output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, provider: 'claude', model: 'claude-sonnet-4-6' },
    });
    const bridge = new LanguageModelBridge(
      { prompt: 'unused', model: 'claude-sonnet-4-6', sessionId: 's3', cwd: process.cwd() },
      fake,
      'claude',
    );
    assert.equal(bridge.capabilities.promptCache, 'explicit');
    assert.equal(bridge.capabilities.cacheTtlSeconds, 300);
    assert.equal(bridge.capabilities.maxOutputTokens, false);
  });

  it('parses Anvil Stream Format assistant frames into content + activity events', async () => {
    const assistantFrame = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    const fake = new FakeModelAdapter({
      capabilities: { tier: 'function-calling', streaming: true, toolUse: false, fileSystem: false, shellExecution: false, sessionResume: false },
      result: { output: 'hello world', inputTokens: 1, outputTokens: 2, costUsd: 0, durationMs: 1, provider: 'openai', model: 'gpt-4o-mini' },
      streamLines: [assistantFrame],
    });
    const bridge = new LanguageModelBridge(
      { prompt: 'hi', model: 'gpt-4o-mini', sessionId: 's4', cwd: process.cwd() },
      fake,
      'openai',
    );

    const contents: string[] = [];
    const activities: Array<{ kind: string; summary: string }> = [];
    await new Promise<void>((resolve) => {
      bridge.on('content', (text: string) => contents.push(text));
      bridge.on('activity', (a) => activities.push({ kind: a.kind, summary: a.summary }));
      bridge.on('exit', () => resolve());
      bridge.start();
    });

    assert.deepEqual(contents, ['hello world']);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].kind, 'text');
    assert.equal(activities[0].summary, 'hello world');
  });

  it('emits markCacheBreakpoint sentinel only when promptCache === explicit', () => {
    const claude = new LanguageModelBridge(
      { prompt: 'unused', model: 'claude-sonnet-4-6', sessionId: 's5', cwd: process.cwd() },
      new FakeModelAdapter({
        capabilities: { tier: 'agentic', streaming: true, toolUse: true, fileSystem: true, shellExecution: true, sessionResume: true, cache: 'explicit' },
        result: { output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, provider: 'claude', model: 'claude-sonnet-4-6' },
      }),
      'claude',
    );
    const openai = new LanguageModelBridge(
      { prompt: 'unused', model: 'gpt-4o-mini', sessionId: 's6', cwd: process.cwd() },
      new FakeModelAdapter({
        capabilities: { tier: 'function-calling', streaming: true, toolUse: true, fileSystem: false, shellExecution: false, sessionResume: false, cache: 'auto' },
        result: { output: '', inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, provider: 'openai', model: 'gpt-4o-mini' },
      }),
      'openai',
    );

    const original = 'AAAAA';
    assert.match(claude.markCacheBreakpoint(original, 3), /anvil:cache-breakpoint/);
    assert.equal(openai.markCacheBreakpoint(original, 3), original);
  });
});
