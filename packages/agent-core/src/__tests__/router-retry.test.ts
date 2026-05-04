/**
 * Phase 2 tests for the per-error retry engine.
 *
 * Uses a deterministic fake clock so backoff delays don't slow the suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runWithRetry,
  DEFAULT_RETRY_POLICY,
  LlmRouter,
} from '../router/index.js';
import type {
  RetryPolicy,
  ErrorClass,
  RouterConfig,
} from '../router/index.js';
import type {
  LanguageModel,
  LanguageModelInvokeOptions,
  InvokeResult,
  ProviderCapabilities,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const fakeCapabilities: ProviderCapabilities = {
  tier: 'function-calling',
  streaming: false,
  toolUse: false,
  fileSystem: false,
  shellExecution: false,
  sessionResume: false,
};

function makeFakeAdapter(
  responses: Array<{ ok?: InvokeResult; err?: unknown }>,
): { adapter: LanguageModel; calls: number } {
  let calls = 0;
  const adapter: LanguageModel = {
    provider: 'claude',
    capabilities: fakeCapabilities,
    supportsModel: () => true,
    getModelPricing: () => null,
    checkAvailability: async () => ({ available: true }),
    invokeStream: async function* () {
      /* unused */
    },
    invoke: async (_opts: LanguageModelInvokeOptions): Promise<InvokeResult> => {
      const r = responses[calls];
      calls += 1;
      if (!r) throw new Error('fake adapter: ran out of responses');
      if (r.err) throw r.err;
      return r.ok!;
    },
  };
  return {
    adapter,
    get calls() {
      return calls;
    },
  } as unknown as { adapter: LanguageModel; calls: number };
}

function fakeResult(): InvokeResult {
  return {
    text: 'hi',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0.001,
    durationMs: 1,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    finishReason: 'end',
  };
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  delays: number[];
}

function makeFakeClock(): FakeClock {
  let nowMs = 0;
  const delays: number[] = [];
  return {
    delays,
    now: () => nowMs,
    sleep: async (ms: number) => {
      delays.push(ms);
      nowMs += ms;
    },
  };
}

const policyFor = (cls: ErrorClass): RetryPolicy => DEFAULT_RETRY_POLICY[cls];

// ---------------------------------------------------------------------------
// runWithRetry direct tests
// ---------------------------------------------------------------------------

describe('runWithRetry', () => {
  it('returns immediately when fn succeeds first try', async () => {
    const clock = makeFakeClock();
    const out = await runWithRetry<number>(
      async () => 42,
      { policyFor, sleep: clock.sleep, now: clock.now },
    );
    assert.equal(out.result, 42);
    assert.equal(out.attempts.length, 1);
    assert.equal(clock.delays.length, 0);
  });

  it('classifies 429 → rate_limit and retries 5 times exponentially', async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const out = await runWithRetry<string>(
      async () => {
        calls += 1;
        if (calls <= 3) {
          throw Object.assign(new Error('rate limited'), { status: 429 });
        }
        return 'ok';
      },
      { policyFor, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
    );
    assert.equal(out.result, 'ok');
    assert.equal(out.attempts.length, 4);
    // attempts 0-2 errored; attempt 3 succeeded. 3 sleeps occurred.
    assert.equal(clock.delays.length, 3);
    // No jitter (random=0.5 → 0 deviation), exponential 1000/2000/4000.
    assert.deepEqual(clock.delays, [1000, 2000, 4000]);
    assert.equal(out.attempts[0].errorClass, 'rate_limit');
  });

  it('honors Retry-After header over computed backoff', async () => {
    const clock = makeFakeClock();
    let calls = 0;
    await runWithRetry<string>(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('429'), {
            status: 429,
            headers: { 'retry-after': '7' },
          });
        }
        return 'ok';
      },
      { policyFor, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
    );
    assert.deepEqual(clock.delays, [7000]); // 7s honored, not 1s exponential
  });

  it('does NOT retry on auth (401)', async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const out = await runWithRetry<string>(
      async () => {
        calls += 1;
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
      { policyFor, sleep: clock.sleep, now: clock.now },
    );
    assert.equal(calls, 1);
    assert.equal(out.attempts.length, 1);
    assert.equal(out.attempts[0].errorClass, 'auth');
    assert.ok(out.error);
    assert.equal(clock.delays.length, 0);
  });

  it('does NOT retry on content_policy', async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const out = await runWithRetry<string>(
      async () => {
        calls += 1;
        throw Object.assign(new Error('safety filter rejected'), {
          status: 400,
          error: { type: 'content_filter' },
        });
      },
      { policyFor, sleep: clock.sleep, now: clock.now },
    );
    assert.equal(calls, 1);
    assert.equal(out.attempts[0].errorClass, 'content_policy');
    assert.ok(out.error);
  });

  it('5xx three times then succeeds', async () => {
    const clock = makeFakeClock();
    let calls = 0;
    const out = await runWithRetry<string>(
      async () => {
        calls += 1;
        if (calls <= 3) throw Object.assign(new Error('boom'), { status: 503 });
        return 'ok';
      },
      { policyFor, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
    );
    assert.equal(out.result, 'ok');
    assert.equal(calls, 4);
    // server_5xx: 200, 400, 800 (exponential, base 200)
    assert.deepEqual(clock.delays, [200, 400, 800]);
  });

  it('caps exponential delay at maxMs', async () => {
    const clock = makeFakeClock();
    const policy: RetryPolicy = {
      attempts: 3,
      backoff: 'exponential',
      baseMs: 1000,
      maxMs: 1500,
      jitter: false,
    };
    let calls = 0;
    await runWithRetry<string>(
      async () => {
        calls += 1;
        if (calls < 4) throw Object.assign(new Error(''), { status: 503 });
        return 'ok';
      },
      {
        policyFor: () => policy,
        sleep: clock.sleep,
        now: clock.now,
      },
    );
    // 1000 capped to 1500, 2000 → 1500, 4000 → 1500
    assert.deepEqual(clock.delays, [1000, 1500, 1500]);
  });

  it('linear backoff multiplies baseMs by attempt number', async () => {
    const clock = makeFakeClock();
    const policy: RetryPolicy = {
      attempts: 3,
      backoff: 'linear',
      baseMs: 500,
      jitter: false,
    };
    let calls = 0;
    await runWithRetry<string>(
      async () => {
        calls += 1;
        if (calls < 4) throw Object.assign(new Error(''), { code: 'ETIMEDOUT' });
        return 'ok';
      },
      { policyFor: () => policy, sleep: clock.sleep, now: clock.now },
    );
    // 500*1, 500*2, 500*3
    assert.deepEqual(clock.delays, [500, 1000, 1500]);
  });
});

// ---------------------------------------------------------------------------
// LlmRouter.invoke single-adapter integration
// ---------------------------------------------------------------------------

describe('LlmRouter.invoke (Phase 2 single-adapter)', () => {
  it('routes by tag to the configured primary model', async () => {
    const { adapter } = makeFakeAdapter([{ ok: fakeResult() }]);
    const config: RouterConfig = {
      routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
    const router = new LlmRouter({
      config,
      resolver: { resolve: (_id) => adapter },
    });
    const out = await router.invoke({ tag: 'planner', prompt: 'hello' });
    assert.equal(out.result?.text, 'hi');
    assert.equal(out.attempts.length, 1);
    assert.equal(out.attempts[0].fallbackIndex, 0);
    assert.equal(out.totalCostUsd, 0.001);
  });

  it('honors raw-model pin escape hatch', async () => {
    let captured = '';
    const adapter: LanguageModel = {
      provider: 'openai',
      capabilities: fakeCapabilities,
      supportsModel: () => true,
      getModelPricing: () => null,
      checkAvailability: async () => ({ available: true }),
      invokeStream: async function* () {},
      invoke: async (opts) => {
        captured = opts.model;
        return { ...fakeResult(), provider: 'openai' };
      },
    };
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      resolver: { resolve: () => adapter },
    });
    await router.invoke({ tag: 'planner', model: 'gpt-4o', prompt: 'q' });
    assert.equal(captured, 'gpt-4o');
  });

  it('throws RouterError with attempt history on terminal failure', async () => {
    const fake = makeFakeAdapter([
      { err: Object.assign(new Error('boom'), { status: 401 }) },
    ]);
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      resolver: { resolve: () => fake.adapter },
    });
    await assert.rejects(
      router.invoke({ tag: 'planner', prompt: 'q' }),
      (e: Error) => {
        assert.equal(e.name, 'RouterError');
        const re = e as Error & { attempts: ReadonlyArray<{ errorClass?: string }> };
        assert.equal(re.attempts.length, 1);
        assert.equal(re.attempts[0].errorClass, 'auth');
        return true;
      },
    );
  });

  it('respects per-provider classifier override', async () => {
    let calls = 0;
    const adapter: LanguageModel = {
      provider: 'gemini',
      capabilities: fakeCapabilities,
      supportsModel: () => true,
      getModelPricing: () => null,
      checkAvailability: async () => ({ available: true }),
      invokeStream: async function* () {},
      invoke: async () => {
        calls += 1;
        if (calls === 1) throw new Error('quota exceeded'); // no status code
        return fakeResult();
      },
    };
    const clock = makeFakeClock();
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'planner', primary: 'gemini-2.5-flash' }],
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      resolver: { resolve: () => adapter },
      sleep: clock.sleep,
      now: clock.now,
      random: () => 0.5,
      errorClassifiers: {
        gemini: (err) => {
          const msg = (err as Error).message ?? '';
          return /quota/i.test(msg) ? 'rate_limit' : undefined;
        },
      },
    });
    const out = await router.invoke({ tag: 'planner', prompt: 'q' });
    assert.equal(out.result?.text, 'hi');
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0].errorClass, 'rate_limit');
  });
});
