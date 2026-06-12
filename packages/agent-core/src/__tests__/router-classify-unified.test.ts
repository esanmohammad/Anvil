/**
 * Phase 0 — unified error taxonomy.
 *
 * `classifyError` is now the SINGLE classifier the whole stack consults
 * (single-shot router invoke, the streaming/agentic chain walk, and the
 * legacy `runWithChainFallback` binary check). These tests lock the cases
 * that mattered for the reliability rewrite — especially the transient
 * network failure (`opencode 0: fetch failed`) that used to kill a run in
 * ~1.5s, and the phantom-model burn-and-hop behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyError,
  isTerminalErrorClass,
  isFallbackEligibleErrorClass,
} from '../router/errors.js';
import { DEFAULT_RETRY_POLICY } from '../router/retry.js';
import { UpstreamError } from '../upstream-error.js';

describe('classifyError — network / transient', () => {
  it('classifies the canonical "opencode 0: fetch failed" as timeout (fall-back eligible)', () => {
    const err = new UpstreamError(0, 'fetch failed: fetch failed', { provider: 'opencode', retryable: true });
    const cls = classifyError(err);
    assert.equal(cls, 'timeout');
    assert.equal(isFallbackEligibleErrorClass(cls), true);
    assert.equal(isTerminalErrorClass(cls), false);
  });

  it('classifies bare "fetch failed" message as timeout', () => {
    assert.equal(classifyError(new Error('fetch failed')), 'timeout');
  });

  it('classifies ECONNRESET / EPIPE / UND_ERR_SOCKET codes as timeout', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ETIMEDOUT']) {
      const e = Object.assign(new Error('socket'), { code });
      assert.equal(classifyError(e), 'timeout', code);
    }
  });

  it('classifies AbortError / TimeoutError by name', () => {
    assert.equal(classifyError(Object.assign(new Error('x'), { name: 'AbortError' })), 'timeout');
    assert.equal(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  });
});

describe('classifyError — status codes', () => {
  it('429 → rate_limit, 5xx → server_5xx, 401/403 → auth', () => {
    assert.equal(classifyError(new UpstreamError(429, '', { provider: 't' })), 'rate_limit');
    assert.equal(classifyError(new UpstreamError(503, '', { provider: 't' })), 'server_5xx');
    assert.equal(classifyError(new UpstreamError(500, '', { provider: 't' })), 'server_5xx');
    assert.equal(classifyError(new UpstreamError(401, '', { provider: 't' })), 'auth');
    assert.equal(classifyError(new UpstreamError(403, '', { provider: 't' })), 'auth');
  });

  it('408 / 425 → timeout', () => {
    assert.equal(classifyError(new UpstreamError(408, '', { provider: 't' })), 'timeout');
    assert.equal(classifyError(new UpstreamError(425, '', { provider: 't' })), 'timeout');
  });

  it('400 → invalid_request unless a content/safety hint is present', () => {
    assert.equal(classifyError(new UpstreamError(400, 'bad params', { provider: 't' })), 'invalid_request');
    assert.equal(
      classifyError(new UpstreamError(400, 'request refused by safety filter', { provider: 't' })),
      'content_policy',
    );
  });
});

describe('classifyError — body patterns', () => {
  it('phantom model / unsupported op → model_unavailable', () => {
    for (const body of [
      'model not found',
      'gemini-3-pro is not supported for generateContent',
      'no such model',
      'model_not_found',
    ]) {
      assert.equal(classifyError(new UpstreamError(400, body, { provider: 't' })), 'model_unavailable', body);
    }
  });

  it('hard billing block → model_unavailable (hop, do not backoff-retry same model)', () => {
    assert.equal(
      classifyError(new UpstreamError(402, 'Credit balance is too low', { provider: 't' })),
      'model_unavailable',
    );
  });

  it('quota / overloaded / too-many-requests body → rate_limit', () => {
    for (const body of [
      'insufficient quota',
      'overloaded_error',
      'resource exhausted',
      'server is busy',
      'too many requests',
    ]) {
      assert.equal(classifyError(new UpstreamError(200, body, { provider: 't' })), 'rate_limit', body);
    }
  });

  it('auth/permission body → auth (terminal)', () => {
    assert.equal(classifyError(new Error('invalid api key')), 'auth');
    assert.equal(classifyError(new Error('permission denied')), 'auth');
  });
});

describe('classifyError — fallback semantics', () => {
  it('a plain unknown error is NOT fall-back eligible', () => {
    const cls = classifyError(new Error('something exploded in our own code'));
    assert.equal(cls, 'unknown');
    assert.equal(isFallbackEligibleErrorClass(cls), false);
  });

  it('explicit retryable=true with no matching pattern → timeout (eligible)', () => {
    const err = Object.assign(new Error('weird transient'), { retryable: true });
    assert.equal(classifyError(err), 'timeout');
    assert.equal(isFallbackEligibleErrorClass(classifyError(err)), true);
  });

  it('terminal classes are never fall-back eligible', () => {
    for (const cls of ['auth', 'content_policy', 'invalid_request'] as const) {
      assert.equal(isTerminalErrorClass(cls), true);
      assert.equal(isFallbackEligibleErrorClass(cls), false);
    }
  });

  it('model_unavailable is non-terminal, eligible, and has zero same-model retries', () => {
    assert.equal(isTerminalErrorClass('model_unavailable'), false);
    assert.equal(isFallbackEligibleErrorClass('model_unavailable'), true);
    assert.equal(DEFAULT_RETRY_POLICY.model_unavailable.attempts, 0);
  });
});
