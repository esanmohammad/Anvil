/**
 * Phase 7 — checkpoint similarity index.
 *
 * The unit goal: an entry recorded for one slot is only retrievable by a
 * vec inside that same slot, the threshold actually filters, persistence
 * round-trips through disk, and re-recording the same hash dedupes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CheckpointSimilarityIndex } from '../checkpoint-similarity-index.js';
import { embedPrompt } from '../prompt-similarity.js';

// ── Test scaffold ──────────────────────────────────────────────────────

let anvilHome = '';
const PROJECT = 'test-proj';

function makeFilter(over: Partial<{ runFamily: string; stage: string; taskId: string; model: string; promptVersion: string }> = {}) {
  return {
    runFamily: 'rf-1',
    stage: 'plan',
    taskId: 'clarifier:clarify',
    model: 'claude-haiku-4-5',
    promptVersion: '1',
    ...over,
  };
}

function makeEntry(over: Partial<Parameters<CheckpointSimilarityIndex['add']>[0]> = {}) {
  return {
    runFamily: 'rf-1',
    stage: 'plan',
    taskId: 'clarifier:clarify',
    model: 'claude-haiku-4-5',
    promptVersion: '1',
    vec: embedPrompt('Add a Stripe webhook handler to the checkout flow.'),
    outputRef: 'sha-abc',
    hash: 'hash-abc',
    cost: { usd: 0.001, tokensIn: 100, tokensOut: 50 },
    recordedAt: '2026-04-28T12:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  anvilHome = mkdtempSync(join(tmpdir(), 'anvil-cp-sim-'));
});

afterEach(() => {
  if (anvilHome) rmSync(anvilHome, { recursive: true, force: true });
  anvilHome = '';
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('CheckpointSimilarityIndex', () => {
  it('add + nearest finds an identical-prompt match within the same slot', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const prompt = 'Add a Stripe webhook handler to the checkout flow.';
    idx.add(makeEntry({ vec: embedPrompt(prompt) }));

    const match = idx.nearest(makeFilter(), embedPrompt(prompt), 0.95);
    assert.ok(match, 'expected an identical-prompt match');
    assert.equal(match.entry.outputRef, 'sha-abc');
    assert.ok(match.score >= 0.999, `expected score≈1, got ${match.score}`);
  });

  it('catches a one-word edit at threshold 0.95', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const original = 'Add a Stripe webhook handler to the checkout flow that records each event in the audit log.';
    const edited   = 'Also add a Stripe webhook handler to the checkout flow that records each event in the audit log.';
    idx.add(makeEntry({ vec: embedPrompt(original) }));

    const match = idx.nearest(makeFilter(), embedPrompt(edited), 0.95);
    assert.ok(match, 'expected a near-edit match at threshold 0.95');
  });

  it('rejects matches below threshold', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    idx.add(makeEntry({ vec: embedPrompt('Add a Stripe webhook handler to the checkout flow.') }));

    const match = idx.nearest(
      makeFilter(),
      embedPrompt('Display refund history on the customer profile screen and let admins export CSV.'),
      0.95,
    );
    assert.equal(match, null, 'unrelated prompt should not match');
  });

  it('does not cross slot boundaries (different stage → no hit)', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const prompt = 'Add a Stripe webhook handler to the checkout flow.';
    idx.add(makeEntry({ vec: embedPrompt(prompt), stage: 'plan' }));

    const match = idx.nearest(makeFilter({ stage: 'implement' }), embedPrompt(prompt), 0.95);
    assert.equal(match, null, 'similarity must not cross stages');
  });

  it('does not cross slot boundaries (different model → no hit)', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const prompt = 'Add a Stripe webhook handler to the checkout flow.';
    idx.add(makeEntry({ vec: embedPrompt(prompt), model: 'claude-haiku-4-5' }));

    const match = idx.nearest(makeFilter({ model: 'claude-sonnet-4-6' }), embedPrompt(prompt), 0.95);
    assert.equal(match, null, 'similarity must not bleed across models');
  });

  it('add() upserts on duplicate hash (no growth, latest outputRef wins)', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const prompt = 'Add a Stripe webhook handler to the checkout flow.';
    idx.add(makeEntry({ vec: embedPrompt(prompt), hash: 'h1', outputRef: 'sha-old' }));
    idx.add(makeEntry({ vec: embedPrompt(prompt), hash: 'h1', outputRef: 'sha-new' }));

    assert.equal(idx.size(), 1, 'duplicate hash should upsert, not append');
    const match = idx.nearest(makeFilter(), embedPrompt(prompt), 0.95);
    assert.ok(match);
    assert.equal(match.entry.outputRef, 'sha-new');
  });

  it('persists across instances — second instance reads what the first wrote', () => {
    const prompt = 'Add a Stripe webhook handler to the checkout flow.';
    const first = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    first.add(makeEntry({ vec: embedPrompt(prompt) }));

    const second = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const match = second.nearest(makeFilter(), embedPrompt(prompt), 0.95);
    assert.ok(match, 'second instance should see persisted entry');
    assert.equal(match.entry.outputRef, 'sha-abc');
  });

  it('clear() drops all entries, both in-memory and on-disk', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    idx.add(makeEntry());
    assert.equal(idx.size(), 1);
    idx.clear();
    assert.equal(idx.size(), 0);

    // Fresh instance also sees an empty index
    const fresh = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    assert.equal(fresh.size(), 0);
  });

  it('returns the highest-cosine match when multiple entries clear the threshold', () => {
    const idx = new CheckpointSimilarityIndex({ anvilHome, project: PROJECT });
    const queryPrompt   = 'Add a Stripe webhook handler to the checkout flow that records each event in the audit log.';
    const closePrompt   = 'Also add a Stripe webhook handler to the checkout flow that records each event in the audit log.';
    const closerPrompt  = queryPrompt; // identical → cosine 1
    idx.add(makeEntry({ vec: embedPrompt(closePrompt), hash: 'h-close', outputRef: 'sha-close' }));
    idx.add(makeEntry({ vec: embedPrompt(closerPrompt), hash: 'h-closer', outputRef: 'sha-closer' }));

    const match = idx.nearest(makeFilter(), embedPrompt(queryPrompt), 0.95);
    assert.ok(match);
    assert.equal(match.entry.outputRef, 'sha-closer', 'should pick the higher-cosine entry');
  });
});
