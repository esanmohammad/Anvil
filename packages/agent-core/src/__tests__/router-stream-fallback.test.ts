/**
 * Phase 2 — `LlmRouter.invokeStream()` chain walk.
 *
 * This is the layer that fixes the production failure: a transient connect
 * error (`opencode 0: fetch failed`) must back off and recover on the same
 * model — and only burn + fall back once the model's retry policy is spent —
 * instead of the old zero-backoff burn-through that killed a run in ~1.5s.
 *
 * Fakes give the router deterministic sleep/clock/jitter so we can assert the
 * exact attempt + backoff behavior without real delays.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LlmRouter } from '../router/router.js';
import { DEFAULT_RETRY_POLICY } from '../router/retry.js';
import { RouterError } from '../router/errors.js';
import { UpstreamError } from '../upstream-error.js';
import type { AdapterResolver } from '../router/router.js';
import type { RouterConfig, RouteOutcome } from '../router/types.js';
import type { LanguageModel, StreamEvent, InvokeResult } from '../types.js';

function okResult(model: string, text: string): InvokeResult {
  return {
    text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0.001, durationMs: 1, provider: 'openrouter', model, finishReason: 'end',
  };
}

interface FakeSpec {
  /** Fail the first N invokeStream calls (connect-time throw) before succeeding. */
  failFirstN?: number;
  /** Error thrown on a failing call (default: retryable network fetch-failed). */
  failWith?: () => Error;
  /** Events the successful stream yields. */
  events?: StreamEvent[];
  text?: string;
}

function fakeLM(model: string, spec: FakeSpec): LanguageModel & { calls: number } {
  const failWith = spec.failWith ?? (() => new UpstreamError(0, 'fetch failed: fetch failed', { provider: 'openrouter', retryable: true }));
  const lm = {
    calls: 0,
    provider: 'openrouter' as LanguageModel['provider'],
    capabilities: { streaming: true } as LanguageModel['capabilities'],
    supportsModel: () => true,
    getModelPricing: () => null,
    async checkAvailability() { return { available: true }; },
    async invoke() { return okResult(model, spec.text ?? 'ok'); },
    async *invokeStream(): AsyncGenerator<StreamEvent, InvokeResult> {
      lm.calls += 1;
      if (spec.failFirstN && lm.calls <= spec.failFirstN) throw failWith();
      for (const e of spec.events ?? [{ type: 'text-delta', text: spec.text ?? 'ok' }]) yield e;
      return okResult(model, spec.text ?? 'ok');
    },
  };
  return lm;
}

function makeRouter(config: RouterConfig, models: Record<string, LanguageModel>) {
  const sleeps: number[] = [];
  let tick = 0;
  const resolver: AdapterResolver = {
    resolve: (id) => {
      const m = models[id];
      if (!m) throw new Error(`no fake for ${id}`);
      return m;
    },
  };
  const router = new LlmRouter({
    config,
    resolver,
    sleep: async (ms: number) => { sleeps.push(ms); },
    now: () => (tick += 1),
    random: () => 0.5,
  });
  return { router, sleeps };
}

async function drive(gen: AsyncGenerator<StreamEvent, RouteOutcome>): Promise<{ events: StreamEvent[]; outcome: RouteOutcome }> {
  const events: StreamEvent[] = [];
  const it = gen[Symbol.asyncIterator]();
  while (true) {
    const s = await it.next();
    if (s.done) return { events, outcome: s.value };
    events.push(s.value);
  }
}

describe('LlmRouter.invokeStream — backoff recovery (same model)', () => {
  it('retries a transient fetch-failed with backoff, then recovers', async () => {
    const m1 = fakeLM('m1', { failFirstN: 2, text: 'recovered' });
    const config: RouterConfig = {
      routes: [{ tag: 't', primary: 'm1' }],
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
    const { router, sleeps } = makeRouter(config, { m1 });
    const { events, outcome } = await drive(router.invokeStream({ tag: 't', prompt: 'hi' }));

    assert.equal(m1.calls, 3, 'should fail twice then succeed');
    assert.equal(sleeps.length, 2, 'two backoff delays before the successful attempt');
    assert.ok(sleeps[1] >= sleeps[0], 'linear/exponential backoff is non-decreasing');
    assert.equal(outcome.result?.text, 'recovered');
    assert.equal(outcome.attempts.length, 3);
    assert.deepEqual(events.map((e) => e.type).filter((t) => t === 'text-delta').length, 1);
  });
});

describe('LlmRouter.invokeStream — cross-model fallback', () => {
  it('burns a permanently-failing model and falls back to the next chain entry', async () => {
    const m1 = fakeLM('m1', { failFirstN: 999 });
    const m2 = fakeLM('m2', { text: 'from-fallback' });
    const config: RouterConfig = {
      routes: [{ tag: 't', primary: 'm1', fallbacks: [{ model: 'm2' }] }],
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
    const { router } = makeRouter(config, { m1, m2 });
    const { outcome } = await drive(router.invokeStream({ tag: 't', prompt: 'hi' }));

    assert.equal(outcome.result?.text, 'from-fallback');
    assert.equal(outcome.result?.model, 'm2');
    // m1 exhausts its timeout policy (attempts:3 → 4 tries) before burning.
    assert.equal(m1.calls, DEFAULT_RETRY_POLICY.timeout.attempts + 1);
    assert.equal(m2.calls, 1);
    assert.ok(outcome.attempts.some((a) => a.model === 'm1'));
    assert.ok(outcome.attempts.some((a) => a.model === 'm2'));
  });
});

describe('LlmRouter.invokeStream — terminal errors never fall back', () => {
  it('an auth error surfaces immediately and does NOT try the fallback model', async () => {
    const m1 = fakeLM('m1', {
      failFirstN: 999,
      failWith: () => new UpstreamError(401, 'invalid api key', { provider: 'openrouter', retryable: false }),
    });
    const m2 = fakeLM('m2', { text: 'should-not-run' });
    const config: RouterConfig = {
      routes: [{ tag: 't', primary: 'm1', fallbacks: [{ model: 'm2' }] }],
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
    const { router, sleeps } = makeRouter(config, { m1, m2 });

    await assert.rejects(() => drive(router.invokeStream({ tag: 't', prompt: 'hi' })), RouterError);
    assert.equal(m1.calls, 1, 'auth is terminal — no same-model retry');
    assert.equal(m2.calls, 0, 'auth is terminal — no cross-model fallback');
    assert.equal(sleeps.length, 0, 'no backoff for a terminal error');
  });
});
