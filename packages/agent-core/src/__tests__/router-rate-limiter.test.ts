/**
 * Phase 3 tests for the token-bucket rate limiter.
 *
 * Uses a deterministic fake clock so refill math is reproducible and
 * `await sleep()` doesn't actually pause the suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TokenBucketRateLimiter,
  RateLimitedError,
  DEFAULT_RATE_LIMITS,
} from '../router/index.js';

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
    sleep: async (ms) => {
      delays.push(ms);
      nowMs += ms;
    },
  };
}

describe('DEFAULT_RATE_LIMITS', () => {
  it('covers the 7 known providers', () => {
    for (const p of ['claude', 'openai', 'gemini', 'openrouter', 'ollama', 'gemini-cli', 'adk']) {
      assert.ok(p in DEFAULT_RATE_LIMITS, `missing default for ${p}`);
    }
  });
});

describe('TokenBucketRateLimiter', () => {
  it('returns true immediately for unbounded providers', async () => {
    const clock = makeFakeClock();
    const rl = new TokenBucketRateLimiter({
      config: { local: {} },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await rl.acquire('local', 1000), true);
    assert.equal(clock.delays.length, 0);
  });

  it('passes 10 RPM-budgeted calls under bucket; waits the 11th', async () => {
    const clock = makeFakeClock();
    const rl = new TokenBucketRateLimiter({
      config: { fake: { rpm: 10 } },
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 10; i++) {
      await rl.acquire('fake', 0);
    }
    assert.equal(clock.delays.length, 0);
    // 11th must wait until at least one token refills (1 token / 6000ms @ 10 rpm).
    await rl.acquire('fake', 0);
    assert.equal(clock.delays.length, 1);
    assert.equal(clock.delays[0], 6000);
  });

  it('refills proportionally to elapsed time', async () => {
    let nowMs = 0;
    const rl = new TokenBucketRateLimiter({
      config: { fake: { rpm: 60 } }, // 1 token/sec
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });
    // Drain bucket
    for (let i = 0; i < 60; i++) await rl.acquire('fake', 0);
    // Advance fake time by 30s — should refill 30 tokens
    nowMs += 30_000;
    const snap = rl.snapshot('fake');
    assert.ok(snap.rpm !== undefined && snap.rpm >= 29.5 && snap.rpm <= 30.5, `expected ~30, got ${snap.rpm}`);
  });

  it('honors TPM budget (token-weighted reservation)', async () => {
    const clock = makeFakeClock();
    const rl = new TokenBucketRateLimiter({
      config: { fake: { tpm: 10_000 } },
      now: clock.now,
      sleep: clock.sleep,
    });
    await rl.acquire('fake', 9_000);
    await rl.acquire('fake', 999);
    // remaining 1 token → call asking 100 must wait 99 tokens worth of refill
    assert.equal(clock.delays.length, 0);
    await rl.acquire('fake', 100);
    assert.equal(clock.delays.length, 1);
    // refill rate = 10_000 / 60_000 ms = 1/6 tok/ms; need 99 tokens → 594ms
    assert.ok(clock.delays[0] >= 590 && clock.delays[0] <= 600);
  });

  it('throws RateLimitedError when onRateLimit=fail', async () => {
    const clock = makeFakeClock();
    const rl = new TokenBucketRateLimiter({
      config: { fake: { rpm: 1 } },
      now: clock.now,
      sleep: clock.sleep,
      onRateLimit: 'fail',
    });
    await rl.acquire('fake', 0);
    await assert.rejects(
      rl.acquire('fake', 0),
      (e: Error) => {
        assert.equal(e.name, 'RateLimitedError');
        assert.ok((e as RateLimitedError).waitMs > 0);
        return true;
      },
    );
  });

  it('returns false when onRateLimit=fallback', async () => {
    const clock = makeFakeClock();
    const rl = new TokenBucketRateLimiter({
      config: { fake: { rpm: 1 } },
      now: clock.now,
      sleep: clock.sleep,
      onRateLimit: 'fallback',
    });
    assert.equal(await rl.acquire('fake', 0), true);
    assert.equal(await rl.acquire('fake', 0), false);
    assert.equal(clock.delays.length, 0);
  });

  it('isolates buckets per provider', async () => {
    const clock = makeFakeClock();
    const rl = new TokenBucketRateLimiter({
      config: { a: { rpm: 1 }, b: { rpm: 1 } },
      now: clock.now,
      sleep: clock.sleep,
    });
    await rl.acquire('a', 0);
    await rl.acquire('b', 0); // different bucket — should not wait
    assert.equal(clock.delays.length, 0);
  });
});
