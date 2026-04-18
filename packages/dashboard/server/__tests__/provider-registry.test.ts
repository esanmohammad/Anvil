/**
 * Tests for provider-registry module.
 *
 * Uses node:test + node:assert (built-in test runner).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverProviders,
  getModelsForCapability,
  invalidateProviderCache,
  type DiscoveryResult,
  type Capability,
} from '../provider-registry.js';

// ── discoverProviders ────────────────────────────────────────────────────

describe('discoverProviders', () => {
  beforeEach(() => {
    invalidateProviderCache();
  });

  it('returns a DiscoveryResult with providers array', async () => {
    const result = await discoverProviders();
    assert.ok(Array.isArray(result.providers), 'providers should be an array');
    assert.ok(result.providers.length > 0, 'should discover at least one provider');
  });

  it('each provider has required fields', async () => {
    const result = await discoverProviders();
    for (const provider of result.providers) {
      assert.ok(typeof provider.name === 'string' && provider.name.length > 0, `provider.name should be a non-empty string, got: ${provider.name}`);
      assert.ok(typeof provider.displayName === 'string' && provider.displayName.length > 0, `provider.displayName should be a non-empty string`);
      assert.ok(provider.type === 'cli' || provider.type === 'api', `provider.type should be "cli" or "api", got: ${provider.type}`);
      assert.ok(typeof provider.available === 'boolean', `provider.available should be boolean`);
      assert.ok(Array.isArray(provider.models), `provider.models should be an array`);
      assert.ok(Array.isArray(provider.capabilities), `provider.capabilities should be an array`);
    }
  });

  it('CLI providers have binary field', async () => {
    const result = await discoverProviders();
    const cliProviders = result.providers.filter(p => p.type === 'cli');
    assert.ok(cliProviders.length > 0, 'should have at least one CLI provider');
    for (const provider of cliProviders) {
      assert.ok(typeof provider.binary === 'string' && provider.binary.length > 0, `CLI provider "${provider.name}" should have a binary field`);
    }
  });

  it('API providers have envVar field', async () => {
    const result = await discoverProviders();
    const apiProviders = result.providers.filter(p => p.type === 'api');
    // Ollama is API type but may not have envVar, filter it out
    const apiWithEnv = apiProviders.filter(p => p.name !== 'ollama');
    assert.ok(apiWithEnv.length > 0, 'should have at least one API provider (non-ollama)');
    for (const provider of apiWithEnv) {
      assert.ok(typeof provider.envVar === 'string' && provider.envVar.length > 0, `API provider "${provider.name}" should have an envVar field`);
    }
  });

  it('defaultModel is a non-empty string', async () => {
    const result = await discoverProviders();
    assert.ok(typeof result.defaultModel === 'string', 'defaultModel should be a string');
    assert.ok(result.defaultModel.length > 0, 'defaultModel should not be empty');
  });

  it('defaultProvider is a non-empty string', async () => {
    const result = await discoverProviders();
    assert.ok(typeof result.defaultProvider === 'string', 'defaultProvider should be a string');
    assert.ok(result.defaultProvider.length > 0, 'defaultProvider should not be empty');
  });

  it('models flat list contains models from all providers', async () => {
    const result = await discoverProviders();
    assert.ok(Array.isArray(result.models), 'models should be an array');
    // Every model in the flat list should reference an existing provider
    const providerNames = new Set(result.providers.map(p => p.name));
    for (const model of result.models) {
      assert.ok(providerNames.has(model.provider), `model "${model.id}" references unknown provider "${model.provider}"`);
    }
  });
});

// ── getModelsForCapability ───────────────────────────────────────────────

describe('getModelsForCapability', () => {
  let result: DiscoveryResult;

  beforeEach(async () => {
    invalidateProviderCache();
    result = await discoverProviders();
  });

  it('filters chat models correctly', () => {
    const chatModels = getModelsForCapability(result, 'chat');
    assert.ok(chatModels.length > 0, 'should find at least one chat model');
    for (const model of chatModels) {
      assert.ok(model.capabilities.includes('chat'), `model "${model.id}" should have chat capability`);
    }
  });

  it('filters agentic models correctly', () => {
    const agenticModels = getModelsForCapability(result, 'agentic');
    // Agentic models are CLI-based, may or may not be available
    for (const model of agenticModels) {
      assert.ok(model.capabilities.includes('agentic'), `model "${model.id}" should have agentic capability`);
    }
  });

  it('returns empty array for capability with no models', () => {
    // Construct a result with no reranking models (unless Ollama has some)
    const fakeResult: DiscoveryResult = {
      providers: [],
      defaultModel: 'test',
      defaultProvider: 'test',
      models: [
        { id: 'test-model', displayName: 'Test', provider: 'test', capabilities: ['chat'] },
      ],
    };
    const rerankers = getModelsForCapability(fakeResult, 'reranking');
    assert.equal(rerankers.length, 0, 'should return empty array when no models match');
  });
});

// ── invalidateProviderCache ──────────────────────────────────────────────

describe('invalidateProviderCache', () => {
  it('clears cache so next call re-discovers', async () => {
    // First call populates cache
    const first = await discoverProviders();
    assert.ok(first.providers.length > 0);

    // Second call should return cached result (same reference)
    const second = await discoverProviders();
    assert.deepStrictEqual(first, second, 'cached result should match');

    // Invalidate and call again
    invalidateProviderCache();
    const third = await discoverProviders();
    // Should still be valid data (re-discovered)
    assert.ok(third.providers.length > 0, 'should still discover providers after cache invalidation');
  });
});

// ── Ollama graceful failure ──────────────────────────────────────────────

describe('Ollama detection', () => {
  it('handles network failure gracefully (Ollama not running)', async () => {
    // Save original env
    const origHost = process.env.OLLAMA_HOST;
    // Point to an invalid host so Ollama detection fails
    process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
    invalidateProviderCache();

    try {
      const result = await discoverProviders();
      const ollama = result.providers.find(p => p.name === 'ollama');
      assert.ok(ollama, 'ollama provider should exist in the list');
      assert.equal(ollama.available, false, 'ollama should not be available when host is unreachable');
      assert.deepStrictEqual(ollama.models, [], 'ollama should have empty models when unavailable');
    } finally {
      // Restore
      if (origHost !== undefined) {
        process.env.OLLAMA_HOST = origHost;
      } else {
        delete process.env.OLLAMA_HOST;
      }
      invalidateProviderCache();
    }
  });
});
