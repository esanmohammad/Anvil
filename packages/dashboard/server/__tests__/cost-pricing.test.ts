/**
 * Tests for cost-pricing — known models priced correctly, unknown falls
 * back to Sonnet and warns once.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { priceUsd, listPricing, __resetWarnedForTests } from '../cost-pricing.js';

describe('cost-pricing', () => {
  beforeEach(() => {
    __resetWarnedForTests();
  });

  it('prices Opus correctly', () => {
    // Opus: $15 in / $75 out per 1M tokens
    // 1,000,000 in + 0 out = $15; 0 in + 1,000,000 out = $75
    assert.equal(priceUsd('claude-opus-4-7', 1_000_000, 0), 15);
    assert.equal(priceUsd('claude-opus-4-7', 0, 1_000_000), 75);
    // Small call — 1000 in, 500 out = 15*0.001 + 75*0.0005 = 0.015 + 0.0375 = 0.0525
    assert.equal(priceUsd('claude-opus-4-7', 1000, 500), 0.0525);
  });

  it('prices Sonnet correctly', () => {
    // Sonnet: $3 in / $15 out
    assert.equal(priceUsd('claude-sonnet-4-6', 1_000_000, 0), 3);
    assert.equal(priceUsd('claude-sonnet-4-6', 0, 1_000_000), 15);
  });

  it('prices Haiku correctly', () => {
    // Haiku: $1 in / $5 out
    assert.equal(priceUsd('claude-haiku-4-5-20251001', 1_000_000, 0), 1);
    assert.equal(priceUsd('claude-haiku-4-5-20251001', 0, 1_000_000), 5);
  });

  it('falls back to Sonnet pricing for unknown models', () => {
    const sonnet = priceUsd('claude-sonnet-4-6', 10_000, 5_000);
    const unknown = priceUsd('totally-made-up-model', 10_000, 5_000);
    assert.equal(unknown, sonnet);
  });

  it('warns only once per unknown model', () => {
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      priceUsd('made-up-a', 100, 100);
      priceUsd('made-up-a', 100, 100);
      priceUsd('made-up-a', 100, 100);
      priceUsd('made-up-b', 100, 100);
    } finally {
      console.warn = origWarn;
    }
    // One warning per distinct unknown model.
    assert.equal(warnings.length, 2);
  });

  it('rounds to 6 decimal places', () => {
    const usd = priceUsd('claude-haiku-4-5', 1, 1);
    // 1*1/1e6 + 1*5/1e6 = 6e-6
    assert.equal(usd, 0.000006);
  });

  it('clamps negative / non-finite token counts', () => {
    assert.equal(priceUsd('claude-sonnet-4-6', -1, -1), 0);
    assert.equal(priceUsd('claude-sonnet-4-6', NaN, 1000), priceUsd('claude-sonnet-4-6', 0, 1000));
  });

  it('listPricing returns all models', () => {
    const rows = listPricing();
    const ids = rows.map((r) => r.model);
    assert.ok(ids.includes('claude-opus-4-7'));
    assert.ok(ids.includes('claude-sonnet-4-6'));
    assert.ok(ids.includes('claude-haiku-4-5-20251001'));
    for (const r of rows) {
      assert.ok(r.inPerMTok > 0);
      assert.ok(r.outPerMTok > 0);
    }
  });
});
