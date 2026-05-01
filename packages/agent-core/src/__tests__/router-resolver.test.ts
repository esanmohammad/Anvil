/**
 * Phase 3 — resolver: capability + complexity + prefer → routing chain.
 *
 * Pure function tests; no I/O. Each test composes a small registry inline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveModel,
  ModelResolutionError,
} from '../router/resolver.js';
import type { ModelRegistry, ModelEntry } from '../router/model-registry.js';

function entry(over: Partial<ModelEntry>): ModelEntry {
  return {
    id: 'x',
    provider: 'ollama',
    tier: 'local',
    capabilities: ['code'],
    complexity_max: 'M',
    vram_gb: 1,
    exclusive_slot: false,
    ...over,
  };
}

function reg(...models: ModelEntry[]): ModelRegistry {
  return { models };
}

describe('resolveModel — happy path', () => {
  it('returns primary + fallbacks across tier preference', () => {
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['local', 'cheap', 'premium'] },
      reg(
        entry({ id: 'qwen-7b', tier: 'local' }),
        entry({ id: 'haiku', tier: 'cheap', provider: 'claude' }),
        entry({ id: 'opus', tier: 'premium', provider: 'claude', complexity_max: 'L' }),
      ),
    );
    assert.equal(r.primary, 'qwen-7b');
    assert.deepEqual(r.fallbacks.map((f) => f.model), ['haiku', 'opus']);
  });

  it('returns only the primary when one tier matches and prefer is single', () => {
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['premium'] },
      reg(
        entry({ id: 'qwen-7b', tier: 'local' }),
        entry({ id: 'opus', tier: 'premium', provider: 'claude', complexity_max: 'L' }),
      ),
    );
    assert.equal(r.primary, 'opus');
    assert.deepEqual(r.fallbacks, []);
  });

  it('preserves yaml-declared order within a tier', () => {
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['local'] },
      reg(
        entry({ id: 'first',  tier: 'local' }),
        entry({ id: 'second', tier: 'local' }),
        entry({ id: 'third',  tier: 'local' }),
      ),
    );
    assert.equal(r.primary, 'first');
    assert.deepEqual(r.fallbacks.map((f) => f.model), ['second', 'third']);
  });

  it('walks tiers in declared `prefer` order (premium-first valid)', () => {
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['premium', 'local'] },
      reg(
        entry({ id: 'qwen-7b', tier: 'local' }),
        entry({ id: 'opus', tier: 'premium', provider: 'claude', complexity_max: 'L' }),
      ),
    );
    assert.equal(r.primary, 'opus');
    assert.deepEqual(r.fallbacks.map((f) => f.model), ['qwen-7b']);
  });

  it('skips tiers absent from prefer entirely', () => {
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['local'] },
      reg(
        entry({ id: 'qwen-7b', tier: 'local' }),
        entry({ id: 'haiku', tier: 'cheap', provider: 'claude' }),
        entry({ id: 'opus', tier: 'premium', provider: 'claude', complexity_max: 'L' }),
      ),
    );
    assert.equal(r.primary, 'qwen-7b');
    assert.deepEqual(r.fallbacks, []);
  });
});

describe('resolveModel — filters', () => {
  it('rejects models lacking the requested capability', () => {
    assert.throws(
      () =>
        resolveModel(
          { capability: 'vision', complexity: 'S', prefer: ['local'] },
          reg(entry({ id: 'qwen-7b', tier: 'local', capabilities: ['code'] })),
        ),
      ModelResolutionError,
    );
  });

  it('rejects models whose complexity_max is below requested', () => {
    assert.throws(
      () =>
        resolveModel(
          { capability: 'code', complexity: 'L', prefer: ['local'] },
          reg(entry({ id: 'qwen-7b', tier: 'local', complexity_max: 'M' })),
        ),
      ModelResolutionError,
    );
  });

  it('respects minContextTokens when set', () => {
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['local', 'premium'], minContextTokens: 200_000 },
      reg(
        entry({ id: 'qwen-7b', tier: 'local', context_tokens: 8192 }),
        entry({
          id: 'opus',
          tier: 'premium',
          provider: 'claude',
          complexity_max: 'L',
          context_tokens: 200_000,
        }),
      ),
    );
    assert.equal(r.primary, 'opus');
    assert.deepEqual(r.fallbacks, []);
  });

  it('omits models marked unavailable in the availability map', () => {
    const registry: ModelRegistry = reg(
      entry({ id: 'down', tier: 'local' }),
      entry({ id: 'up',   tier: 'local' }),
    );
    registry.availability = new Map();
    registry.availability.set('down', { available: false, lastChecked: Date.now() });
    registry.availability.set('up',   { available: true,  lastChecked: Date.now() });
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['local'] },
      registry,
    );
    assert.equal(r.primary, 'up');
    assert.deepEqual(r.fallbacks, []);
  });

  it('treats missing availability entry as available (opt-in unavailability)', () => {
    const registry: ModelRegistry = reg(entry({ id: 'untouched', tier: 'local' }));
    registry.availability = new Map(); // empty map
    const r = resolveModel(
      { capability: 'code', complexity: 'S', prefer: ['local'] },
      registry,
    );
    assert.equal(r.primary, 'untouched');
  });
});

describe('resolveModel — empty result diagnostics', () => {
  it('throws ModelResolutionError with per-step counts', () => {
    let caught: ModelResolutionError | null = null;
    try {
      resolveModel(
        { capability: 'vision', complexity: 'L', prefer: ['local'] },
        reg(
          entry({ id: 'a', tier: 'local', capabilities: ['code'] }),
          entry({ id: 'b', tier: 'local', capabilities: ['vision'], complexity_max: 'S' }),
        ),
      );
    } catch (e) {
      caught = e as ModelResolutionError;
    }
    assert.ok(caught, 'should throw');
    assert.equal(caught?.diagnostic.totalInRegistry, 2);
    assert.equal(caught?.diagnostic.matchedCapability, 1, 'only b has vision');
    assert.equal(caught?.diagnostic.matchedComplexity, 0, 'b is S, requested L');
    assert.match(caught!.message, /no model matches/);
    assert.match(caught!.message, /vision/);
    assert.match(caught!.message, /complexity: L/);
  });

  it('throws when registry is empty', () => {
    assert.throws(
      () =>
        resolveModel(
          { capability: 'code', complexity: 'S', prefer: ['local'] },
          reg(),
        ),
      ModelResolutionError,
    );
  });

  it('throws when no model matches the prefer tiers', () => {
    assert.throws(
      () =>
        resolveModel(
          { capability: 'code', complexity: 'S', prefer: ['premium'] },
          reg(entry({ id: 'qwen-7b', tier: 'local' })),
        ),
      ModelResolutionError,
    );
  });
});
