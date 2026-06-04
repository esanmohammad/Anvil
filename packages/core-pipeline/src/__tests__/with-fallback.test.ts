/**
 * Tests for runWithChainFallback. Validates the burn-set semantics,
 * retryable detection, max-attempts cap, and non-retryable propagation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWithChainFallback, isRetryableUpstreamError } from '../routing/with-fallback.js';

class TestUpstream extends Error {
  override name = 'UpstreamError';
  retryable: boolean;
  status: number;
  constructor(status: number, retryable: boolean) {
    super(`upstream ${status}`);
    this.status = status;
    this.retryable = retryable;
  }
}

describe('runWithChainFallback', () => {
  it('returns success on first attempt when nothing throws', async () => {
    const calls: string[] = [];
    const out = await runWithChainFallback(
      { stageName: 's', resolveModel: () => 'm1' },
      async (m) => { calls.push(m); return 'ok'; },
    );
    assert.equal(out, 'ok');
    assert.deepEqual(calls, ['m1']);
  });

  it('walks the chain on retryable errors and burns models', async () => {
    const calls: string[] = [];
    const burned: string[] = [];
    const sequence = ['m1', 'm2', 'm3'];
    let i = 0;
    const out = await runWithChainFallback(
      {
        stageName: 's',
        resolveModel: (excl) => {
          // Pick the next un-burned model.
          const m = sequence.find((s) => !excl.has(s));
          if (!m) throw new Error('chain exhausted');
          return m;
        },
        onBurn: (info) => burned.push(info.model),
      },
      async (m) => {
        calls.push(m);
        i += 1;
        if (i < 3) throw new TestUpstream(503, true);
        return `done:${m}`;
      },
    );
    assert.equal(out, 'done:m3');
    assert.deepEqual(calls, ['m1', 'm2', 'm3']);
    assert.deepEqual(burned, ['m1', 'm2']);
  });

  it('propagates non-retryable errors without burning', async () => {
    const burned: string[] = [];
    await assert.rejects(
      runWithChainFallback(
        {
          stageName: 's',
          resolveModel: () => 'm1',
          onBurn: (i) => burned.push(i.model),
        },
        async () => { throw new TestUpstream(400, false); },
      ),
      /upstream 400/,
    );
    assert.deepEqual(burned, []);
  });

  it('caps attempts at maxAttempts and throws the last error', async () => {
    let count = 0;
    await assert.rejects(
      runWithChainFallback(
        {
          stageName: 's',
          resolveModel: () => `m${count}`,
          maxAttempts: 2,
        },
        async () => { count += 1; throw new TestUpstream(503, true); },
      ),
      /upstream 503/,
    );
    assert.equal(count, 2);
  });
});

describe('runWithChainFallback — prefix-aware resume (H2 §2.3/§2.4)', () => {
  it('passes prefill resolved after a burn into the NEXT attempt', async () => {
    const seenPrefill: Array<unknown> = [];
    const sequence = ['m1', 'm2'];
    let i = 0;
    const out = await runWithChainFallback<string, { text: string }>(
      {
        stageName: 's',
        resolveModel: (excl) => sequence.find((s) => !excl.has(s))!,
        // Simulate reading the burned model's partial from the store.
        resolvePrefill: async ({ burnedModel, attemptIndex }) => ({
          text: `partial-from-${burnedModel}@${attemptIndex}`,
        }),
      },
      async (model, prefill) => {
        seenPrefill.push(prefill);
        i += 1;
        if (i < 2) throw new TestUpstream(503, true);
        return `done:${model}`;
      },
    );
    assert.equal(out, 'done:m2');
    // First attempt: no prefill. Second attempt: prefill from m1's burn.
    assert.equal(seenPrefill[0], undefined);
    assert.deepEqual(seenPrefill[1], { text: 'partial-from-m1@1' });
  });

  it('falls back to a prefill-less retry when resolvePrefill throws', async () => {
    const seenPrefill: Array<unknown> = [];
    const sequence = ['m1', 'm2'];
    let i = 0;
    const out = await runWithChainFallback<string, { text: string }>(
      {
        stageName: 's',
        resolveModel: (excl) => sequence.find((s) => !excl.has(s))!,
        resolvePrefill: async () => { throw new Error('store read failed'); },
      },
      async (model, prefill) => {
        seenPrefill.push(prefill);
        i += 1;
        if (i < 2) throw new TestUpstream(503, true);
        return `done:${model}`;
      },
    );
    assert.equal(out, 'done:m2');
    assert.equal(seenPrefill[1], undefined, 'failed prefill read → clean retry, not a failed run');
  });

  it('passes the resolved nextModel into resolvePrefill (§2.3.3 truncation budget)', async () => {
    const infos: Array<{ burnedModel: string; attemptIndex: number; nextModel?: string }> = [];
    const sequence = ['m1', 'm2'];
    let i = 0;
    const out = await runWithChainFallback<string, { text: string }>(
      {
        stageName: 's',
        resolveModel: (excl) => sequence.find((s) => !excl.has(s))!,
        resolvePrefill: async (info) => {
          infos.push(info);
          return { text: 'p' };
        },
      },
      async (model) => {
        i += 1;
        if (i < 2) throw new TestUpstream(503, true);
        return `done:${model}`;
      },
    );
    assert.equal(out, 'done:m2');
    assert.equal(infos.length, 1, 'resolvePrefill called once (after the single burn)');
    assert.deepEqual(infos[0], { burnedModel: 'm1', attemptIndex: 1, nextModel: 'm2' },
      'resolver sees the burned model AND the target it will be served to');
  });

  it('never resolves a prefill when none is wired (legacy behavior)', async () => {
    const seenPrefill: Array<unknown> = [];
    const sequence = ['m1', 'm2'];
    let i = 0;
    await runWithChainFallback(
      {
        stageName: 's',
        resolveModel: (excl) => sequence.find((s) => !excl.has(s))!,
      },
      async (model, prefill) => {
        seenPrefill.push(prefill);
        i += 1;
        if (i < 2) throw new TestUpstream(503, true);
        return `done:${model}`;
      },
    );
    assert.deepEqual(seenPrefill, [undefined, undefined]);
  });
});

describe('isRetryableUpstreamError', () => {
  it('matches explicit retryable=true', () => {
    assert.equal(isRetryableUpstreamError(new TestUpstream(503, true)), true);
  });
  it('matches UpstreamError with 429/502/503/504 status even without retryable flag', () => {
    const e = { name: 'UpstreamError', status: 502 };
    assert.equal(isRetryableUpstreamError(e), true);
  });
  it('rejects 400 / non-UpstreamError', () => {
    assert.equal(isRetryableUpstreamError(new Error('plain')), false);
    assert.equal(isRetryableUpstreamError({ name: 'UpstreamError', status: 400 }), false);
  });
  it('rejects null/undefined/string', () => {
    assert.equal(isRetryableUpstreamError(null), false);
    assert.equal(isRetryableUpstreamError(undefined), false);
    assert.equal(isRetryableUpstreamError('boom'), false);
  });
});
