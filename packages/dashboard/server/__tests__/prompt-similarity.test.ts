/**
 * Phase 7 — local prompt embedder + cosine.
 *
 * The unit goal: small textual edits map to small vector deltas, so the
 * default similarity threshold (0.95) catches one-word edits but rejects
 * unrelated prompts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { embedPrompt, cosine, EMBEDDING_VERSION } from '../prompt-similarity.js';

describe('embedPrompt', () => {
  it('is deterministic — same input produces the same vector', () => {
    const a = embedPrompt('Add a Stripe webhook handler to the checkout flow.');
    const b = embedPrompt('Add a Stripe webhook handler to the checkout flow.');
    assert.deepEqual(a, b);
  });

  it('lowercases input — case-only changes are no-ops', () => {
    const lower = embedPrompt('add a stripe webhook handler to the checkout flow.');
    const upper = embedPrompt('Add a Stripe Webhook Handler to the Checkout Flow.');
    assert.deepEqual(lower, upper);
  });

  it('returns a 256-dim l2-normalized vector for non-trivial input', () => {
    const v = embedPrompt('Render a list of recent invoices on the billing page.');
    assert.equal(v.length, 256);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    // l2 norm should be 1 (within fp tolerance)
    assert.ok(Math.abs(sumSq - 1) < 1e-9, `expected l2 norm 1, got ${Math.sqrt(sumSq)}`);
  });

  it('returns the zero vector for too-short input (len < NGRAM)', () => {
    const v = embedPrompt('hi');
    assert.equal(v.length, 256);
    for (const x of v) assert.equal(x, 0);
  });

  it('exports a stable EMBEDDING_VERSION (changes invalidate persisted indices)', () => {
    assert.equal(typeof EMBEDDING_VERSION, 'number');
    assert.ok(EMBEDDING_VERSION >= 1);
  });
});

describe('cosine', () => {
  it('identical prompts → cosine 1.0', () => {
    const a = embedPrompt('Add a Stripe webhook handler to the checkout flow.');
    const b = embedPrompt('Add a Stripe webhook handler to the checkout flow.');
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-9);
  });

  it('one-word edit on a longish prompt → cosine well above 0.95', () => {
    const original = 'Add a Stripe webhook handler to the checkout flow that records each event in the audit log.';
    const edited   = 'Also add a Stripe webhook handler to the checkout flow that records each event in the audit log.';
    const score = cosine(embedPrompt(original), embedPrompt(edited));
    assert.ok(
      score >= 0.95,
      `expected cosine ≥ 0.95 for one-word edit, got ${score.toFixed(4)}`,
    );
  });

  it('whole rewrite on the same topic → cosine below 0.95', () => {
    const a = 'Add a Stripe webhook handler to the checkout flow that records audit events.';
    const b = 'Display refund history on the customer profile screen and let admins export CSV.';
    const score = cosine(embedPrompt(a), embedPrompt(b));
    assert.ok(
      score < 0.95,
      `expected cosine < 0.95 for unrelated prompts, got ${score.toFixed(4)}`,
    );
  });

  it('returns 0 for mismatched dims (corrupt-index posture)', () => {
    assert.equal(cosine([1, 0, 0], [1, 0]), 0);
  });
});
