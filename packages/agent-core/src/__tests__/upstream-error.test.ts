/**
 * UpstreamError — shared contract for all adapters' chain-fallback
 * trigger. The dashboard's runStageWithFallback duck-types this shape
 * (name + retryable + status). Lock the classification rules so a
 * future tweak doesn't silently regress chain-fallback behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  UpstreamError,
  isRetryableStatus,
  bodyLooksRetryable,
  synthesizeStatusFromCli,
} from '../upstream-error.js';

describe('UpstreamError — status-based classification', () => {
  it('marks 429 / 502 / 503 / 504 / 0 retryable', () => {
    for (const status of [429, 502, 503, 504, 0, 408, 425]) {
      const e = new UpstreamError(status, '', { provider: 'test' });
      assert.equal(e.retryable, true, `status=${status} should be retryable`);
      assert.equal(e.status, status);
      assert.equal(e.name, 'UpstreamError');
    }
  });

  it('marks 400 / 401 / 403 / 404 NOT retryable (config errors)', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const e = new UpstreamError(status, '', { provider: 'test' });
      assert.equal(e.retryable, false, `status=${status} should NOT be retryable`);
    }
  });

  it('overrides retryable when explicitly passed', () => {
    const forced = new UpstreamError(400, '', { provider: 'x', retryable: true });
    assert.equal(forced.retryable, true);
    const suppressed = new UpstreamError(429, '', { provider: 'x', retryable: false });
    assert.equal(suppressed.retryable, false);
  });

  it('promotes to retryable when body matches a known transient pattern', () => {
    // 200/400 with quota body — happens with OpenRouter wrapping upstreams.
    const cases = [
      'insufficient_quota',
      'rate_limit_exceeded',
      'overloaded_error',
      'RESOURCE_EXHAUSTED',
      'Quota exceeded for project',
      'server is busy, please retry',
      'Too many requests, slow down',
    ];
    for (const body of cases) {
      const e = new UpstreamError(400, body, { provider: 'test' });
      assert.equal(e.retryable, true, `body="${body}" should mark retryable`);
    }
  });

  it('formats a clean message including provider + truncated body', () => {
    const e = new UpstreamError(429, 'rate_limit_exceeded', { provider: 'anthropic' });
    assert.match(e.message, /^anthropic 429: rate_limit_exceeded/);
  });
});

describe('isRetryableStatus', () => {
  it('returns the canonical retryable set', () => {
    const retryable = [0, 408, 425, 429, 502, 503, 504];
    const terminal = [200, 201, 301, 400, 401, 403, 404, 422, 500, 501];
    for (const s of retryable) assert.equal(isRetryableStatus(s), true, String(s));
    for (const s of terminal) assert.equal(isRetryableStatus(s), false, String(s));
  });
});

describe('bodyLooksRetryable', () => {
  it('matches common transient-condition phrasings', () => {
    const yes = [
      'insufficient_quota',
      'Insufficient Quota',
      'rate_limit_error',
      'rate-limit exceeded',
      'overloaded_error',
      'resource_exhausted',
      'RESOURCE EXHAUSTED',
      'Quota exceeded for the day',
      'server busy, retry shortly',
      'Service is temporarily unavailable',
      'too many requests',
      "qwen/qwen3-coder:free is temporarily rate-limited upstream",
    ];
    for (const body of yes) assert.equal(bodyLooksRetryable(body), true, body);
  });

  it('does NOT match auth / config / null bodies', () => {
    const no = [
      '',
      'invalid api key',
      'unauthorized',
      'permission_denied',
      'context length exceeded',  // model-side limit, not retryable to a different model
      'invalid_request_error',
    ];
    for (const body of no) assert.equal(bodyLooksRetryable(body), false, body);
  });
});

describe('synthesizeStatusFromCli — CLI subprocess stderr classification', () => {
  it('maps Anthropic CLI quota / rate-limit stderr to retryable 429', () => {
    const cases = [
      'rate_limit_error: Number of request tokens has exceeded',
      'overloaded_error: Server is overloaded; retry later',
      'Credit balance is too low to access the Anthropic API',
      '429 Too Many Requests',
      'insufficient_quota for organization',
    ];
    for (const stderr of cases) {
      const r = synthesizeStatusFromCli(stderr);
      assert.ok(r, `expected synth for "${stderr}"`);
      assert.equal(r!.status, 429);
      assert.equal(r!.retryable, true);
    }
  });

  it('maps Gemini CLI quota / rate-limit stderr to retryable 429', () => {
    const cases = [
      'RESOURCE_EXHAUSTED: Quota exceeded for project foo',
      'Quota exceeded for metric: generate_content_free_tier_requests',
      'rate limit exceeded: 60 requests/minute',
    ];
    for (const stderr of cases) {
      const r = synthesizeStatusFromCli(stderr);
      assert.ok(r, `expected synth for "${stderr}"`);
      assert.equal(r!.status, 429);
      assert.equal(r!.retryable, true);
    }
  });

  it('maps outage signals to retryable 503', () => {
    const cases = [
      'INTERNAL Server Error',
      '503 Service Unavailable',
      'Gateway timeout reached',
    ];
    for (const stderr of cases) {
      const r = synthesizeStatusFromCli(stderr);
      assert.ok(r, `expected synth for "${stderr}"`);
      assert.equal(r!.status, 503);
      assert.equal(r!.retryable, true);
    }
  });

  it('maps auth errors to NON-retryable 401', () => {
    const cases = [
      'Invalid API key',
      'API key not valid',
      'Unauthorized: 401',
      'permission denied for project',
    ];
    for (const stderr of cases) {
      const r = synthesizeStatusFromCli(stderr);
      assert.ok(r, `expected synth for "${stderr}"`);
      assert.equal(r!.status, 401);
      assert.equal(r!.retryable, false);
    }
  });

  it('returns undefined for unknown stderr (caller falls back to plain Error)', () => {
    assert.equal(synthesizeStatusFromCli(''), undefined);
    assert.equal(synthesizeStatusFromCli('Segmentation fault'), undefined);
    assert.equal(synthesizeStatusFromCli('Cannot find module foo'), undefined);
  });
});

describe('Dashboard duck-type compatibility', () => {
  // Mirror the exact check from
  // packages/dashboard/server/pipeline-runner.ts:333 — every adapter's
  // UpstreamError MUST satisfy this so chain-fallback works.
  function isRetryableUpstreamError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: string; retryable?: unknown; status?: unknown };
    if (e.retryable === true) return true;
    if (e.name === 'UpstreamError' && typeof e.status === 'number') {
      return e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504;
    }
    return false;
  }

  it('retryable UpstreamError instances pass the dashboard duck-type', () => {
    const e1 = new UpstreamError(429, 'rate_limit', { provider: 'anthropic' });
    const e2 = new UpstreamError(503, 'overloaded', { provider: 'gemini' });
    const e3 = new UpstreamError(400, 'overloaded_error', { provider: 'anthropic' }); // body-promoted
    assert.equal(isRetryableUpstreamError(e1), true);
    assert.equal(isRetryableUpstreamError(e2), true);
    assert.equal(isRetryableUpstreamError(e3), true);
  });

  it('non-retryable UpstreamError instances are correctly rejected', () => {
    const e1 = new UpstreamError(401, 'invalid api key', { provider: 'gemini' });
    const e2 = new UpstreamError(400, 'invalid_request_error', { provider: 'anthropic' });
    assert.equal(isRetryableUpstreamError(e1), false);
    assert.equal(isRetryableUpstreamError(e2), false);
  });
});
