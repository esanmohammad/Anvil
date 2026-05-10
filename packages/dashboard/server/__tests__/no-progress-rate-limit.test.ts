/**
 * H7 — NoProgressDetector + RateLimiter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NoProgressDetector,
  RateLimiter,
  RateLimitError,
} from '../browser/no-progress-detector.js';

describe('NoProgressDetector', () => {
  it('does not stall on the first observation', () => {
    const d = new NoProgressDetector();
    const r = d.observe({ url: 'a', viewportHash: 'h', lastInteractionType: 'click' });
    assert.equal(r.stalled, false);
    assert.equal(r.streak, 1);
  });

  it('flags stall after threshold consecutive identical observations', () => {
    const d = new NoProgressDetector({ threshold: 3 });
    const t = { url: 'a', viewportHash: 'h', lastInteractionType: 'click' };
    assert.equal(d.observe(t).stalled, false);
    assert.equal(d.observe(t).stalled, false);
    const r = d.observe(t);
    assert.equal(r.stalled, true);
    assert.equal(r.streak, 3);
  });

  it('resets streak on a different observation', () => {
    const d = new NoProgressDetector({ threshold: 3 });
    const t1 = { url: 'a', viewportHash: 'h', lastInteractionType: 'click' };
    const t2 = { url: 'b', viewportHash: 'h', lastInteractionType: 'click' };
    d.observe(t1); d.observe(t1);
    const r = d.observe(t2);
    assert.equal(r.stalled, false);
    assert.equal(r.streak, 1);
  });

  it('reset() clears state', () => {
    const d = new NoProgressDetector({ threshold: 2 });
    const t = { url: 'a', viewportHash: 'h', lastInteractionType: 'click' };
    d.observe(t); d.observe(t);
    d.reset();
    assert.equal(d.observe(t).stalled, false);
  });
});

describe('RateLimiter', () => {
  it('allows up to maxInWindow', () => {
    const r = new RateLimiter(3, 1000);
    r.consume(0); r.consume(100); r.consume(500);
  });

  it('throws when over the limit', () => {
    const r = new RateLimiter(2, 1000);
    r.consume(0); r.consume(100);
    assert.throws(() => r.consume(200), RateLimitError);
  });

  it('expires old events past the window', () => {
    const r = new RateLimiter(2, 1000);
    r.consume(0); r.consume(500);
    // At t=1001, the event at t=0 has slipped past the 1000ms window.
    r.consume(1001);
    assert.throws(() => r.consume(1100), RateLimitError);
  });

  it('tryConsume returns false instead of throwing', () => {
    const r = new RateLimiter(1, 1000);
    assert.equal(r.tryConsume(0), true);
    assert.equal(r.tryConsume(100), false);
    assert.equal(r.tryConsume(1500), true);
  });
});
