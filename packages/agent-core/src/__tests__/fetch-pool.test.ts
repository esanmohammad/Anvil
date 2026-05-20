/**
 * Unit tests for fetch-pool — per-provider dispatcher with heal-on-failure.
 *
 * Covers the eight contracts from FETCH-POOL-MANAGEMENT-PLAN.md §6.1:
 *   a) Lazy construction returns a stable instance per provider
 *   b) Per-provider isolation — different providers get different agents
 *   c) Bounded options applied at construction
 *   d) Recycle on poisoned-error pattern swaps the agent
 *   e) No recycle on non-poisoned errors (e.g. 400, 401, 503)
 *   f) Concurrent recycles coalesce to one bump
 *   g) Metrics shape is well-formed
 *   h) resetAllPools clears state cleanly
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from 'undici';

import {
  getFetchPool,
  recycleFetchPoolOnFailure,
  getPoolMetrics,
  resetAllPools,
} from '../fetch-pool.js';

describe('fetch-pool', () => {
  beforeEach(async () => {
    await resetAllPools();
  });

  it('a) lazy construction returns the same Agent on repeat calls', () => {
    const a1 = getFetchPool('anthropic');
    const a2 = getFetchPool('anthropic');
    assert.ok(a1 instanceof Agent);
    assert.strictEqual(a1, a2, 'second call should return same instance');
  });

  it('b) per-provider isolation — separate Agents per provider', () => {
    const anthropic = getFetchPool('anthropic');
    const gemini = getFetchPool('gemini');
    const opencode = getFetchPool('opencode');
    assert.notStrictEqual(anthropic, gemini);
    assert.notStrictEqual(anthropic, opencode);
    assert.notStrictEqual(gemini, opencode);
  });

  it('c) constructed Agent is bounded — close() resolves without hanging', async () => {
    // Indirect bounded-keep-alive test: a fresh pool with no in-flight work
    // closes synchronously-ish. If construction picked up unbounded defaults,
    // tests for d/f would intermittently hang on the close() inside recycle.
    const agent = getFetchPool('openai');
    const closed = agent.close();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('close hung beyond 500ms')), 500),
      ),
    ]);
  });

  it('d) recycle swaps the Agent when the error matches a poisoned pattern', async () => {
    const before = getFetchPool('opencode');
    await recycleFetchPoolOnFailure('opencode', new TypeError('fetch failed'));
    const after = getFetchPool('opencode');
    assert.notStrictEqual(after, before, 'agent should have been swapped');
    const metrics = getPoolMetrics().find((m) => m.provider === 'opencode');
    assert.ok(metrics);
    assert.strictEqual(metrics.recycleCount, 1);
    assert.ok(metrics.lastRecycleAt);
    assert.match(metrics.lastRecycleReason ?? '', /fetch failed/);
  });

  it('e) does not recycle on non-poisoned errors (real upstream status)', async () => {
    const before = getFetchPool('gemini');
    await recycleFetchPoolOnFailure('gemini', new Error('400 Bad Request'));
    await recycleFetchPoolOnFailure('gemini', new Error('503 Service Unavailable'));
    await recycleFetchPoolOnFailure('gemini', new Error('quota exceeded'));
    const after = getFetchPool('gemini');
    assert.strictEqual(after, before, 'agent must not change on non-network errors');
    const metrics = getPoolMetrics().find((m) => m.provider === 'gemini');
    assert.strictEqual(metrics?.recycleCount, 0);
  });

  it('f) concurrent recycles coalesce — recycleCount increments once', async () => {
    getFetchPool('ollama');
    const err = new TypeError('fetch failed');
    const all = await Promise.all(
      Array.from({ length: 10 }, () =>
        recycleFetchPoolOnFailure('ollama', err),
      ),
    );
    assert.strictEqual(all.length, 10);
    const metrics = getPoolMetrics().find((m) => m.provider === 'ollama');
    assert.strictEqual(metrics?.recycleCount, 1, 'must coalesce to one recycle');
  });

  it('g) getPoolMetrics returns well-shaped entries', async () => {
    getFetchPool('anthropic');
    getFetchPool('openrouter');
    const metrics = getPoolMetrics();
    assert.ok(Array.isArray(metrics));
    assert.strictEqual(metrics.length, 2);
    for (const m of metrics) {
      assert.ok(['anthropic', 'openrouter'].includes(m.provider));
      assert.strictEqual(typeof m.createdAt, 'string');
      assert.match(m.createdAt, /\dT\d/, 'ISO timestamp');
      assert.strictEqual(typeof m.recycleCount, 'number');
      assert.strictEqual(typeof m.active, 'boolean');
      assert.strictEqual(m.active, true, 'idle pool is active');
    }
  });

  it('h) resetAllPools drops all state', async () => {
    getFetchPool('anthropic');
    getFetchPool('gemini');
    assert.strictEqual(getPoolMetrics().length, 2);
    await resetAllPools();
    assert.strictEqual(getPoolMetrics().length, 0);

    // Subsequent get reconstructs cleanly
    const fresh = getFetchPool('anthropic');
    assert.ok(fresh instanceof Agent);
    assert.strictEqual(getPoolMetrics().length, 1);
  });

  it('recycle reads ECONNRESET from err.cause', async () => {
    const before = getFetchPool('anthropic');
    // Node's fetch wraps the underlying socket error in `.cause`.
    const err = new TypeError('fetch failed', {
      cause: new Error('read ECONNRESET'),
    });
    await recycleFetchPoolOnFailure('anthropic', err);
    const after = getFetchPool('anthropic');
    assert.notStrictEqual(after, before);
    const m = getPoolMetrics().find((p) => p.provider === 'anthropic');
    assert.strictEqual(m?.recycleCount, 1);
  });
});
