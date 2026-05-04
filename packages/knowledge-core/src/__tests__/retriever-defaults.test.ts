/**
 * Phase 6 — default-on local reranker + tightened top-K.
 *
 * Pins the retrieval defaults so an accidental edit doesn't silently revert
 * the cost saving:
 *   • `reranker` defaults to 'ollama' so HybridRetriever runs the cross-
 *     encoder step on every query without explicit opt-in,
 *   • `maxChunks` is small (≤10) — the reranker picks the best from the
 *     larger fused+AST candidate pool, so emitting a tight top-K is safe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '@anvil/knowledge-core';
import { createReranker } from '@anvil/knowledge-core';

describe('knowledge defaults — Phase 6', () => {
  it('uses ollama as the default reranker so rerank is always on', () => {
    assert.equal(DEFAULT_CONFIG.retrieval.reranker, 'ollama');
  });

  it('keeps the default top-K tight (≤10) so rerank can re-narrow the pool', () => {
    assert.ok(
      DEFAULT_CONFIG.retrieval.maxChunks <= 10,
      `expected maxChunks ≤ 10 (got ${DEFAULT_CONFIG.retrieval.maxChunks}); ` +
        'Phase 6 relies on a tight top-K to cut chunk-token spend.',
    );
    assert.ok(
      DEFAULT_CONFIG.retrieval.maxChunks >= 5,
      `expected maxChunks ≥ 5 (got ${DEFAULT_CONFIG.retrieval.maxChunks}); ` +
        'too small a top-K starves the model of evidence.',
    );
  });

  it('createReranker("ollama") returns a Reranker (not null)', () => {
    const r = createReranker('ollama');
    assert.ok(r, 'expected createReranker("ollama") to return a Reranker instance');
    assert.equal(typeof r.rerank, 'function');
  });

  it('createReranker default branch returns a Reranker (so unknown values still default-on)', () => {
    // Cast through unknown — the factory's `default` branch is the safety net
    // for forward-compat (new provider names land in config before code).
    const r = createReranker('something-unknown' as unknown as 'ollama');
    assert.ok(r, 'unknown provider should fall through to the default Ollama reranker');
  });
});
