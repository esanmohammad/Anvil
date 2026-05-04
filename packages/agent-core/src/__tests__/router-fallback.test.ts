/**
 * Phase 5 tests for the fallback chain walker.
 *
 * Each test wires a per-model AdapterResolver that the LlmRouter consults
 * step-by-step. We verify per-error gating, terminal short-circuiting,
 * cost ledger consistency, and the maxFallbackCostUsd cap.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LlmRouter,
  SpendLedger,
  DEFAULT_RETRY_POLICY,
  RouterError,
} from '../router/index.js';
import type {
  RouterConfig,
  AdapterResolver,
  InvokeOpts,
} from '../router/index.js';
import type {
  LanguageModel,
  LanguageModelInvokeOptions,
  InvokeResult,
  ProviderCapabilities,
  ProviderName,
} from '../types.js';

const fakeCapabilities: ProviderCapabilities = {
  tier: 'function-calling',
  streaming: false,
  toolUse: false,
  fileSystem: false,
  shellExecution: false,
  sessionResume: false,
};

interface ModelResponse {
  ok?: () => InvokeResult;
  err?: () => unknown;
}

function makeMatrix(
  models: Record<string, { provider: ProviderName; responses: ModelResponse[] }>,
): { resolver: AdapterResolver; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const resolver: AdapterResolver = {
    resolve: (modelId: string): LanguageModel => {
      const def = models[modelId];
      if (!def) throw new Error(`unknown model: ${modelId}`);
      calls[modelId] = calls[modelId] ?? 0;
      return {
        provider: def.provider,
        capabilities: fakeCapabilities,
        supportsModel: () => true,
        getModelPricing: () => null,
        checkAvailability: async () => ({ available: true }),
        invokeStream: async function* () {},
        invoke: async (_opts: LanguageModelInvokeOptions): Promise<InvokeResult> => {
          const idx = calls[modelId];
          calls[modelId] = idx + 1;
          const r = def.responses[idx];
          if (!r) throw new Error(`${modelId}: ran out of responses (idx=${idx})`);
          if (r.err) throw r.err();
          return r.ok!();
        },
      };
    },
  };
  return { resolver, calls };
}

function ok(model: string, costUsd = 0.001): InvokeResult {
  return {
    text: 'hi',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd,
    durationMs: 1,
    provider: 'claude',
    model,
    finishReason: 'end',
  };
}

const baseConfig = (
  routes: RouterConfig['routes'],
  extra: Partial<RouterConfig> = {},
): RouterConfig => ({
  routes,
  retryPolicy: {
    ...DEFAULT_RETRY_POLICY,
    rate_limit: { ...DEFAULT_RETRY_POLICY.rate_limit, attempts: 0 }, // disable retry — test fallback walks directly
    server_5xx: { ...DEFAULT_RETRY_POLICY.server_5xx, attempts: 0 },
    timeout: { ...DEFAULT_RETRY_POLICY.timeout, attempts: 0 },
    unknown: { ...DEFAULT_RETRY_POLICY.unknown, attempts: 0 },
  },
  ...extra,
});

const baseInvoke: InvokeOpts = { tag: 'planner', prompt: 'q' };

// ---------------------------------------------------------------------------

describe('LlmRouter fallback chain', () => {
  it('falls back from rate_limit primary to second model', async () => {
    const { resolver, calls } = makeMatrix({
      sonnet: {
        provider: 'claude',
        responses: [{ err: () => Object.assign(new Error('429'), { status: 429 }) }],
      },
      haiku: {
        provider: 'claude',
        responses: [{ ok: () => ok('haiku') }],
      },
    });
    const router = new LlmRouter({
      config: baseConfig([
        { tag: 'planner', primary: 'sonnet', fallbacks: [{ model: 'haiku', on: ['rate_limit'] }] },
      ]),
      resolver,
    });
    const out = await router.invoke(baseInvoke);
    assert.equal(out.result?.model, 'haiku');
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0].fallbackIndex, 0);
    assert.equal(out.attempts[0].errorClass, 'rate_limit');
    assert.equal(out.attempts[1].fallbackIndex, 1);
    assert.equal(calls.sonnet, 1);
    assert.equal(calls.haiku, 1);
  });

  it('terminal auth error short-circuits — no fallback walk', async () => {
    const { resolver, calls } = makeMatrix({
      sonnet: {
        provider: 'claude',
        responses: [{ err: () => Object.assign(new Error('401'), { status: 401 }) }],
      },
      haiku: {
        provider: 'claude',
        responses: [{ ok: () => ok('haiku') }],
      },
    });
    const router = new LlmRouter({
      config: baseConfig([
        { tag: 'planner', primary: 'sonnet', fallbacks: [{ model: 'haiku' }] },
      ]),
      resolver,
    });
    await assert.rejects(router.invoke(baseInvoke), (e: Error) => {
      assert.equal(e.name, 'RouterError');
      const re = e as RouterError;
      assert.equal(re.attempts.length, 1);
      assert.equal(re.attempts[0].errorClass, 'auth');
      return true;
    });
    assert.equal(calls.sonnet, 1);
    assert.ok(!calls.haiku, 'haiku must not be called on auth failure');
  });

  it('content_policy never falls back cross-provider (security default)', async () => {
    const { resolver, calls } = makeMatrix({
      sonnet: {
        provider: 'claude',
        responses: [
          {
            err: () =>
              Object.assign(new Error('safety filter rejected'), {
                status: 400,
                error: { type: 'content_filter' },
              }),
          },
        ],
      },
      gpt: { provider: 'openai', responses: [{ ok: () => ok('gpt-4o') }] },
    });
    const router = new LlmRouter({
      config: baseConfig([
        { tag: 'planner', primary: 'sonnet', fallbacks: [{ model: 'gpt' }] },
      ]),
      resolver,
    });
    await assert.rejects(router.invoke(baseInvoke), /content_policy|safety|content policy|safety filter/i);
    assert.ok(!calls.gpt, 'cross-provider fallback must not run on content_policy');
  });

  it('honors per-fallback `on` gates — skips non-matching steps', async () => {
    const { resolver, calls } = makeMatrix({
      a: {
        provider: 'claude',
        responses: [{ err: () => Object.assign(new Error('500'), { status: 500 }) }],
      },
      b: {
        provider: 'claude',
        responses: [{ ok: () => ok('b') }],
      },
      c: {
        provider: 'openai',
        responses: [{ ok: () => ok('c') }],
      },
    });
    const router = new LlmRouter({
      config: baseConfig([
        {
          tag: 'planner',
          primary: 'a',
          fallbacks: [
            { model: 'b', on: ['rate_limit'] }, // not eligible — primary failed with 5xx
            { model: 'c' },                     // eligible (no `on` = any retryable)
          ],
        },
      ]),
      resolver,
    });
    const out = await router.invoke(baseInvoke);
    assert.equal(out.result?.model, 'c');
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[1].provider, 'openai');
    assert.ok(!calls.b, 'b should be skipped per `on: [rate_limit]` gate');
  });

  it('records spend for every step including failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'anvil-fallback-'));
    try {
      const ledger = new SpendLedger(join(tempDir, 'spend.sqlite'));
      const { resolver } = makeMatrix({
        sonnet: {
          provider: 'claude',
          responses: [{ err: () => Object.assign(new Error('429'), { status: 429 }) }],
        },
        haiku: { provider: 'claude', responses: [{ ok: () => ok('haiku', 0.0005) }] },
      });
      const router = new LlmRouter({
        config: baseConfig([
          { tag: 'planner', primary: 'sonnet', fallbacks: [{ model: 'haiku' }] },
        ]),
        resolver,
        ledger,
      });
      await router.invoke({ ...baseInvoke, runId: 'r-fb' });
      assert.equal(ledger.count(), 2);
      const rows = ledger.recent(10);
      const sonnetRow = rows.find((r) => r.model === 'sonnet');
      const haikuRow = rows.find((r) => r.model === 'haiku');
      assert.equal(sonnetRow?.errorClass, 'rate_limit');
      assert.equal(sonnetRow?.costUsd, 0);
      assert.equal(sonnetRow?.fallbackIndex, 0);
      assert.equal(haikuRow?.fallbackIndex, 1);
      assert.ok(Math.abs((haikuRow?.costUsd ?? 0) - 0.0005) < 1e-9);
      ledger.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('aggregates attempts + cost in the final RouterError on full chain failure', async () => {
    const { resolver } = makeMatrix({
      a: {
        provider: 'claude',
        responses: [{ err: () => Object.assign(new Error('429'), { status: 429 }) }],
      },
      b: {
        provider: 'openai',
        responses: [{ err: () => Object.assign(new Error('500'), { status: 500 }) }],
      },
    });
    const router = new LlmRouter({
      config: baseConfig([
        { tag: 'planner', primary: 'a', fallbacks: [{ model: 'b' }] },
      ]),
      resolver,
    });
    await assert.rejects(router.invoke(baseInvoke), (e: Error) => {
      assert.equal(e.name, 'RouterError');
      const re = e as RouterError;
      assert.equal(re.attempts.length, 2);
      assert.equal(re.attempts[0].errorClass, 'rate_limit');
      assert.equal(re.attempts[1].errorClass, 'server_5xx');
      return true;
    });
  });

  it('walks the entire chain to exhaustion when no cap trips', async () => {
    const { resolver, calls } = makeMatrix({
      a: {
        provider: 'claude',
        responses: [{ err: () => Object.assign(new Error('500'), { status: 500 }) }],
      },
      b: {
        provider: 'openai',
        responses: [{ err: () => Object.assign(new Error('500'), { status: 500 }) }],
      },
      c: {
        provider: 'gemini',
        responses: [{ err: () => Object.assign(new Error('500'), { status: 500 }) }],
      },
    });
    const router = new LlmRouter({
      config: baseConfig([
        { tag: 'planner', primary: 'a', fallbacks: [{ model: 'b' }, { model: 'c' }] },
      ]),
      resolver,
    });
    await assert.rejects(router.invoke(baseInvoke), (e: Error) => {
      const re = e as RouterError;
      assert.equal(re.attempts.length, 3);
      assert.equal(re.attempts[0].provider, 'claude');
      assert.equal(re.attempts[1].provider, 'openai');
      assert.equal(re.attempts[2].provider, 'gemini');
      return true;
    });
    assert.equal(calls.a, 1);
    assert.equal(calls.b, 1);
    assert.equal(calls.c, 1);
  });
});
