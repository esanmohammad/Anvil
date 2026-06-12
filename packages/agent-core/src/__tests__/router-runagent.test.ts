/**
 * Phase 3 — `LlmRouter.runAgent()` agentic chain walk.
 *
 * This is the reliability primitive every full agent spawn rides on (the
 * one-shot runner AND each turn of a multi-turn session). It replaces the old
 * `runWithChainFallback` (cross-model only, zero backoff) with the layered
 * kernel: per-error-class backoff retry → circuit breaker → unified classify →
 * cross-model burn + durable prefill resume.
 *
 * The attempt is an injected Promise (a full agent spawn, owned by the
 * caller), so these tests drive it with a fake + deterministic clock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LlmRouter } from '../router/router.js';
import { DEFAULT_RETRY_POLICY } from '../router/retry.js';
import { UpstreamError } from '../upstream-error.js';

function makeRouter() {
  const sleeps: number[] = [];
  let tick = 0;
  const router = new LlmRouter({
    config: { routes: [], retryPolicy: DEFAULT_RETRY_POLICY },
    sleep: async (ms: number) => { sleeps.push(ms); },
    now: () => (tick += 1),
    random: () => 0.5,
  });
  return { router, sleeps };
}

const fetchFailed = (provider = 'pa') =>
  new UpstreamError(0, 'fetch failed: fetch failed', { provider, retryable: true });

describe('runAgent — same-model backoff recovery', () => {
  it('backs off and recovers a transient fetch-failed on the same model', async () => {
    let calls = 0;
    const { router, sleeps } = makeRouter();
    const res = await router.runAgent(
      { stage: 'clarify', resolveModel: () => 'm1', providerOf: () => 'pa' },
      async (model) => {
        calls += 1;
        if (calls <= 2) throw fetchFailed();
        return { ok: true, model };
      },
    );
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2, 'two backoff delays before success');
    assert.equal(res.result.ok, true);
    assert.equal(res.model, 'm1');
  });
});

describe('runAgent — cross-model fallback with durable prefill', () => {
  it('burns a dead model, threads the prefill into the next model, recovers', async () => {
    const burns: Array<{ model: string; errorClass: string; delayMs: number }> = [];
    const { router } = makeRouter();
    const res = await router.runAgent(
      {
        stage: 'build',
        resolveModel: (burned) => (burned.has('m1') ? 'm2' : 'm1'),
        providerOf: (m) => (m === 'm1' ? 'pa' : 'pb'),
        resolvePrefill: async ({ burnedModel }) => `prefill-after-${burnedModel}`,
        onBurn: ({ model, errorClass, delayMs }) => burns.push({ model, errorClass, delayMs }),
      },
      async (model: string, prefill?: string) => {
        if (model === 'm1') throw fetchFailed('pa');
        return { model, prefill };
      },
    );
    assert.equal(res.model, 'm2');
    assert.equal(res.result.prefill, 'prefill-after-m1');
    // Observability: the burn carries the unified class + the backoff the UI renders.
    assert.equal(burns.length, 1);
    assert.equal(burns[0].model, 'm1');
    assert.equal(burns[0].errorClass, 'timeout');
    assert.ok(burns[0].delayMs > 0, 'a non-final burn reports the backoff delay');
  });
});

describe('runAgent — terminal + non-eligible errors do not fall back', () => {
  it('an auth error surfaces immediately — no retry, no fallback, no backoff', async () => {
    let m2calls = 0;
    const { router, sleeps } = makeRouter();
    await assert.rejects(() =>
      router.runAgent(
        { stage: 'x', resolveModel: (b) => (b.has('m1') ? 'm2' : 'm1'), providerOf: (m) => m },
        async (model) => {
          if (model === 'm1') throw new UpstreamError(401, 'invalid api key', { provider: 'm1', retryable: false });
          m2calls += 1;
          return { model };
        },
      ),
    );
    assert.equal(m2calls, 0, 'terminal auth never reaches the fallback');
    assert.equal(sleeps.length, 0, 'no backoff for terminal');
  });

  it('an unknown error surfaces (not fall-back eligible) — never burns to another model', async () => {
    let m2calls = 0;
    const { router } = makeRouter();
    await assert.rejects(() =>
      router.runAgent(
        { stage: 'x', resolveModel: (b) => (b.has('m1') ? 'm2' : 'm1'), providerOf: (m) => m },
        async (model) => {
          if (model === 'm1') throw new Error('some internal bug in our own code');
          m2calls += 1;
          return { model };
        },
      ),
    );
    assert.equal(m2calls, 0, 'a generic error must not trigger cross-model fallback');
  });
});
