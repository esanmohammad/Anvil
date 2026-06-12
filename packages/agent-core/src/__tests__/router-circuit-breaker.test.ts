/**
 * Phase 6 tests for the circuit breaker — direct + integrated with
 * LlmRouter's fallback walk.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  LlmRouter,
  DEFAULT_RETRY_POLICY,
} from '../router/index.js';
import type { RouterConfig, AdapterResolver } from '../router/index.js';
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

function fakeOk(model = 'm'): InvokeResult {
  return {
    text: 'ok',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0.001,
    durationMs: 1,
    provider: 'claude',
    model,
    finishReason: 'end',
  };
}

interface MatrixDef {
  provider: ProviderName;
  responses: Array<{ ok?: () => InvokeResult; err?: () => unknown }>;
}

function makeMatrix(models: Record<string, MatrixDef>): {
  resolver: AdapterResolver;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  return {
    calls,
    resolver: {
      resolve: (id) => {
        const def = models[id];
        if (!def) throw new Error(`unknown model: ${id}`);
        calls[id] = calls[id] ?? 0;
        const adapter: LanguageModel = {
          provider: def.provider,
          capabilities: fakeCapabilities,
          supportsModel: () => true,
          getModelPricing: () => null,
          checkAvailability: async () => ({ available: true }),
          invokeStream: (async function* () {}) as unknown as LanguageModel['invokeStream'],
          invoke: async (_o: LanguageModelInvokeOptions) => {
            const idx = calls[id];
            calls[id] = idx + 1;
            const r = def.responses[idx];
            if (!r) throw new Error(`${id}: ran out of responses (idx=${idx})`);
            if (r.err) throw r.err();
            return r.ok!();
          },
        };
        return adapter;
      },
    },
  };
}

const noRetryPolicy: RouterConfig['retryPolicy'] = {
  ...DEFAULT_RETRY_POLICY,
  rate_limit: { ...DEFAULT_RETRY_POLICY.rate_limit, attempts: 0 },
  server_5xx: { ...DEFAULT_RETRY_POLICY.server_5xx, attempts: 0 },
  timeout: { ...DEFAULT_RETRY_POLICY.timeout, attempts: 0 },
  unknown: { ...DEFAULT_RETRY_POLICY.unknown, attempts: 0 },
};

// ---------------------------------------------------------------------------

describe('CircuitBreaker (direct)', () => {
  it('starts closed; allows attempts', () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.canAttempt('claude'), true);
    assert.equal(cb.inspect('claude').state, 'closed');
  });

  it('opens after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({
      config: { failureThreshold: 3, cooldownMs: 1000, halfOpenAttempts: 1 },
    });
    cb.reserveAttempt('claude');
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    assert.equal(cb.canAttempt('claude'), true);
    cb.recordFailure('claude');
    assert.equal(cb.canAttempt('claude'), false);
    assert.equal(cb.inspect('claude').state, 'open');
    assert.equal(cb.inspect('claude').tripCount, 1);
  });

  it('success resets the failure counter', () => {
    const cb = new CircuitBreaker({
      config: { failureThreshold: 3, cooldownMs: 1000, halfOpenAttempts: 1 },
    });
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    cb.recordSuccess('claude');
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    assert.equal(cb.canAttempt('claude'), true, 'still under threshold after reset');
  });

  it('transitions open → half_open after cooldown', () => {
    let nowMs = 1000;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 1, cooldownMs: 5000, halfOpenAttempts: 1 },
      now: () => nowMs,
    });
    cb.recordFailure('claude');
    assert.equal(cb.canAttempt('claude'), false);
    nowMs += 4999;
    assert.equal(cb.canAttempt('claude'), false);
    nowMs += 1; // total elapsed = 5000
    assert.equal(cb.canAttempt('claude'), true);
    assert.equal(cb.inspect('claude').state, 'half_open');
  });

  it('half_open → closed on probe success', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 1, cooldownMs: 1000, halfOpenAttempts: 1 },
      now: () => nowMs,
    });
    cb.recordFailure('claude');
    nowMs += 1000;
    assert.ok(cb.canAttempt('claude'));
    cb.reserveAttempt('claude');
    cb.recordSuccess('claude');
    assert.equal(cb.inspect('claude').state, 'closed');
  });

  it('half_open → open on probe failure (re-trips)', () => {
    let nowMs = 0;
    const cb = new CircuitBreaker({
      config: { failureThreshold: 1, cooldownMs: 1000, halfOpenAttempts: 1 },
      now: () => nowMs,
    });
    cb.recordFailure('claude');
    nowMs += 1000;
    cb.canAttempt('claude'); // transitions to half_open
    cb.reserveAttempt('claude');
    cb.recordFailure('claude');
    assert.equal(cb.inspect('claude').state, 'open');
    assert.equal(cb.inspect('claude').tripCount, 2);
  });

  it('isolates state per provider', () => {
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, cooldownMs: 1000, halfOpenAttempts: 1 },
    });
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    assert.equal(cb.canAttempt('claude'), false);
    assert.equal(cb.canAttempt('openai'), true, 'openai unaffected');
  });

  it('uses the documented defaults', () => {
    assert.equal(DEFAULT_CIRCUIT_BREAKER.failureThreshold, 5);
    assert.equal(DEFAULT_CIRCUIT_BREAKER.cooldownMs, 30_000);
    assert.equal(DEFAULT_CIRCUIT_BREAKER.halfOpenAttempts, 1);
  });
});

// ---------------------------------------------------------------------------

describe('LlmRouter + CircuitBreaker integration', () => {
  it('open breaker skips the provider — chain falls through to next step', async () => {
    let nowMs = 0;
    const { resolver, calls } = makeMatrix({
      claudeModel: {
        provider: 'claude',
        responses: [
          { err: () => Object.assign(new Error('500'), { status: 500 }) },
        ],
      },
      openaiModel: {
        provider: 'openai',
        responses: [{ ok: () => fakeOk('openaiModel') }],
      },
    });
    // Pre-trip the breaker for claude before invoking.
    const cb = new CircuitBreaker({
      config: { failureThreshold: 1, cooldownMs: 60_000, halfOpenAttempts: 1 },
      now: () => nowMs,
    });
    cb.recordFailure('claude'); // trip
    const router = new LlmRouter({
      config: {
        routes: [
          {
            tag: 'planner',
            primary: 'claudeModel',
            fallbacks: [{ model: 'openaiModel' }],
          },
        ],
        retryPolicy: noRetryPolicy,
      },
      resolver,
      circuitBreaker: cb,
      now: () => nowMs,
    });
    const out = await router.invoke({ tag: 'planner', prompt: 'q' });
    assert.equal(out.result?.model, 'openaiModel');
    // claudeModel should NOT have been called.
    assert.ok(!calls.claudeModel, 'open breaker prevented claude adapter call');
    assert.equal(calls.openaiModel, 1);
  });

  it('5 consecutive failures across calls trip the breaker', async () => {
    const cb = new CircuitBreaker({
      config: { failureThreshold: 3, cooldownMs: 60_000, halfOpenAttempts: 1 },
    });
    const { resolver } = makeMatrix({
      bad: {
        provider: 'claude',
        responses: Array.from({ length: 5 }).map(() => ({
          err: () => Object.assign(new Error('500'), { status: 500 }),
        })),
      },
    });
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'p', primary: 'bad' }],
        retryPolicy: noRetryPolicy,
      },
      resolver,
      circuitBreaker: cb,
    });

    // 3 failed calls → breaker opens.
    for (let i = 0; i < 3; i++) {
      await assert.rejects(router.invoke({ tag: 'p', prompt: 'q' }));
    }
    assert.equal(cb.inspect('claude').state, 'open');

    // 4th call: breaker open + only one model in chain → no model attempted.
    // The chain produces no error and no result, which surfaces as a
    // RouterError with the synthetic "produced no error and no result".
    await assert.rejects(router.invoke({ tag: 'p', prompt: 'q' }), /failed/);
  });

  it('does NOT trip on terminal auth failures (provider health is fine)', async () => {
    const cb = new CircuitBreaker({
      config: { failureThreshold: 2, cooldownMs: 60_000, halfOpenAttempts: 1 },
    });
    const { resolver } = makeMatrix({
      m: {
        provider: 'claude',
        responses: [
          { err: () => Object.assign(new Error('401'), { status: 401 }) },
          { err: () => Object.assign(new Error('401'), { status: 401 }) },
          { err: () => Object.assign(new Error('401'), { status: 401 }) },
        ],
      },
    });
    const router = new LlmRouter({
      config: { routes: [{ tag: 'p', primary: 'm' }], retryPolicy: noRetryPolicy },
      resolver,
      circuitBreaker: cb,
    });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(router.invoke({ tag: 'p', prompt: 'q' }));
    }
    assert.equal(cb.inspect('claude').state, 'closed', 'auth errors are caller-side; breaker stays closed');
  });
});
