/**
 * Phase 1 smoke tests for `@esankhan3/anvil-agent-core/router`.
 *
 * Verifies:
 *   1. Module barrel exports the canonical surface
 *   2. Type round-trips (RouterConfig → LlmRouter → getConfig)
 *   3. classifyError dispatches the documented status/code/name table
 *   4. parseRetryAfterMs handles seconds + HTTP-date forms
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LlmRouter,
  RouterError,
  classifyError,
  parseRetryAfterMs,
  ALL_ERROR_CLASSES,
} from '../router/index.js';
import type {
  RetryPolicy,
  RouterConfig,
  ErrorClass,
} from '../router/index.js';

const defaultRetryPolicy: Record<ErrorClass, RetryPolicy> = {
  rate_limit: { attempts: 5, backoff: 'exponential', baseMs: 1000, maxMs: 30000 },
  timeout: { attempts: 3, backoff: 'linear', baseMs: 500, maxMs: 5000 },
  server_5xx: { attempts: 4, backoff: 'exponential', baseMs: 200, maxMs: 5000 },
  auth: { attempts: 0, backoff: 'constant', baseMs: 0 },
  content_policy: { attempts: 0, backoff: 'constant', baseMs: 0 },
  invalid_request: { attempts: 0, backoff: 'constant', baseMs: 0 },
  model_unavailable: { attempts: 0, backoff: 'constant', baseMs: 0 },
  unknown: { attempts: 1, backoff: 'constant', baseMs: 1000 },
};

describe('router/index barrel', () => {
  it('exports the documented public surface', () => {
    assert.equal(typeof LlmRouter, 'function');
    assert.equal(typeof RouterError, 'function');
    assert.equal(typeof classifyError, 'function');
    assert.equal(typeof parseRetryAfterMs, 'function');
    assert.equal(ALL_ERROR_CLASSES.length, 8);
  });
});

describe('LlmRouter scaffold', () => {
  it('round-trips a minimal config through getConfig', () => {
    const config: RouterConfig = {
      routes: [{ tag: 'planner', primary: 'claude-sonnet-4-6' }],
      retryPolicy: defaultRetryPolicy,
    };
    const router = new LlmRouter({ config });
    const snapshot = router.getConfig();
    assert.deepEqual(snapshot.routes, config.routes);
    assert.deepEqual(snapshot.retryPolicy, defaultRetryPolicy);
  });

  it('rejects invoke when no AdapterResolver is wired', async () => {
    const router = new LlmRouter({
      config: {
        routes: [{ tag: 'noop', primary: 'm' }],
        retryPolicy: defaultRetryPolicy,
      },
    });
    await assert.rejects(
      router.invoke({ tag: 'noop', prompt: 'hi' }),
      /AdapterResolver/,
    );
  });
});

describe('classifyError', () => {
  it('maps HTTP status codes', () => {
    assert.equal(classifyError({ status: 429 }), 'rate_limit');
    assert.equal(classifyError({ statusCode: 503 }), 'server_5xx');
    assert.equal(classifyError({ status: 500 }), 'server_5xx');
    assert.equal(classifyError({ status: 401 }), 'auth');
    assert.equal(classifyError({ status: 403 }), 'auth');
    assert.equal(classifyError({ status: 400 }), 'invalid_request');
  });

  it('detects content-policy hints inside 400 responses', () => {
    assert.equal(
      classifyError({ status: 400, error: { type: 'content_filter' } }),
      'content_policy',
    );
    assert.equal(
      classifyError({ status: 400, message: 'safety filter rejected the prompt' }),
      'content_policy',
    );
  });

  it('detects timeouts via name, code, or message', () => {
    assert.equal(classifyError({ name: 'AbortError' }), 'timeout');
    assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'timeout');
    assert.equal(classifyError({ message: 'socket hang up' }), 'timeout');
  });

  it('falls back to unknown when nothing matches', () => {
    assert.equal(classifyError({ message: 'something weird' }), 'unknown');
    assert.equal(classifyError(undefined), 'unknown');
    assert.equal(classifyError(null), 'unknown');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds form', () => {
    assert.equal(parseRetryAfterMs({ 'retry-after': '2' }), 2000);
    assert.equal(parseRetryAfterMs({ 'Retry-After': '0.5' }), 500);
  });

  it('parses HTTP-date form', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs({ 'retry-after': future });
    assert.ok(ms !== null && ms > 50_000 && ms <= 60_000, `expected ~60000ms, got ${ms}`);
  });

  it('returns null when absent or unparseable', () => {
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs({}), null);
    assert.equal(parseRetryAfterMs({ 'retry-after': 'not-a-date' }), null);
  });
});

describe('RouterError', () => {
  it('captures the attempt history', () => {
    const err = new RouterError('all providers failed', {
      attempts: [
        { model: 'a', provider: 'claude', attemptIndex: 0, fallbackIndex: 0, durationMs: 10 },
      ],
    });
    assert.equal(err.name, 'RouterError');
    assert.equal(err.attempts.length, 1);
  });
});
