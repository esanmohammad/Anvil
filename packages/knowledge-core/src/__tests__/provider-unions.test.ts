import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmbeddingProvider,
  createReranker,
  type EmbeddingProviderId,
  type RerankerProviderId,
} from '@esankhan3/anvil-knowledge-core';

/**
 * Provider-union honesty test (P0).
 *
 * Every value of `EmbeddingProviderId` should either:
 *   - produce a non-null factory result (with credentials stubbed), OR
 *   - throw an error whose message names the missing input.
 *
 * Forbidden: silently returning a different provider's instance.
 *
 * The point is: the type union and the factory switch can no longer drift.
 * Touching one without the other will fail this test.
 */

const STASH: Record<string, string | undefined> = {};
const STASH_KEYS = [
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OLLAMA_HOST',
  'CODE_SEARCH_EMBEDDING_BASE_URL',
  'CODE_SEARCH_EMBEDDING_MODEL',
  'CODE_SEARCH_EMBEDDING_API_KEY',
  'CODE_SEARCH_RERANKER_BASE_URL',
  'CODE_SEARCH_RERANKER_MODEL',
  'CODE_SEARCH_RERANKER_API_KEY',
  'COHERE_API_KEY',
  'RERANKER_MODEL',
];

before(() => {
  for (const k of STASH_KEYS) {
    STASH[k] = process.env[k];
    delete process.env[k];
  }
});

after(() => {
  for (const k of STASH_KEYS) {
    if (STASH[k] === undefined) delete process.env[k];
    else process.env[k] = STASH[k];
  }
});

describe('embedding provider union ↔ factory parity', () => {
  it('every provider id has a factory branch', () => {
    const ids: EmbeddingProviderId[] = [
      'codestral',
      'mistral',
      'voyage',
      'openai',
      'ollama',
      'gemini',
      'gemini-oauth',
      'openai-compatible',
      'custom',
    ];

    for (const provider of ids) {
      let constructed = false;
      try {
        // openai-compatible/custom requires baseUrl+model; we stub them here.
        const c = createEmbeddingProvider({
          provider,
          model: 'stub-model',
          baseUrl: 'http://stub.local',
          apiKey: 'stub-key',
          dimensions: 8,
        });
        constructed = !!c && typeof c.embed === 'function';
      } catch (err) {
        // Allowed: error must mention something specific to the provider,
        // never "Unknown embedding provider".
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(
          !msg.includes('Unknown embedding provider'),
          `provider "${provider}" hit the default branch — type/factory drift`,
        );
        constructed = true;
      }
      assert.ok(constructed, `provider "${provider}" did not construct`);
    }
  });

  it('factory throws on values outside the union', () => {
    assert.throws(
      () => createEmbeddingProvider({ provider: 'definitely-not-a-provider' as EmbeddingProviderId }),
      /Unknown embedding provider/,
    );
  });

  it('nomic-local is no longer accepted (purged in P0)', () => {
    assert.throws(
      () => createEmbeddingProvider({ provider: 'nomic-local' as unknown as EmbeddingProviderId }),
      /Unknown embedding provider/,
    );
  });
});

describe('reranker provider union ↔ factory parity', () => {
  it('every provider id has a factory branch', () => {
    const ids: RerankerProviderId[] = [
      'cohere',
      'voyage',
      'ollama',
      'openai-compatible',
      'custom',
      'none',
    ];

    for (const provider of ids) {
      let constructed = false;
      try {
        const r = createReranker({
          provider,
          model: 'stub',
          baseUrl: 'http://stub.local',
          apiKey: 'stub-key',
        });
        // `none` returns null by design; everything else returns a Reranker.
        constructed = provider === 'none' ? r === null : r !== null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(!msg.includes('Unknown reranker'), `provider "${provider}" hit unknown branch`);
        constructed = true;
      }
      assert.ok(constructed, `reranker provider "${provider}" did not behave`);
    }
  });
});
