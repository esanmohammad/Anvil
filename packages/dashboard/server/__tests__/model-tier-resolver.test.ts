/**
 * Phase 5 — local-tier routing on the model-tier-resolver.
 *
 * Verifies the resolver:
 *   • escalates fast-tier clarify/ship to the local weight class when the
 *     ANVIL_LOCAL_TIER_ENABLED env flag is set,
 *   • falls back to the remote-fast model when no local model is discovered,
 *   • leaves behavior untouched when the flag is off,
 *   • doesn't escalate any other (tier, stage) pair to local.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveModelByTier,
  setDiscoveryResult,
  invalidateResolverCache,
} from '../model-tier-resolver.js';
import type { DiscoveryResult, ModelInfo } from '../provider-registry.js';

// ── Fixture builder ────────────────────────────────────────────────────

function makeDiscovery(opts: { withLocal: boolean }): DiscoveryResult {
  const models: ModelInfo[] = [
    { id: 'claude-haiku-4-5', displayName: 'Haiku', provider: 'claude', capabilities: ['agentic', 'chat'], tier: 'fast' },
    { id: 'claude-sonnet-4-6', displayName: 'Sonnet', provider: 'claude', capabilities: ['agentic', 'chat'], tier: 'balanced' },
    { id: 'claude-opus-4-7', displayName: 'Opus', provider: 'claude', capabilities: ['agentic', 'chat'], tier: 'powerful' },
  ];
  if (opts.withLocal) {
    models.push({
      id: 'qwen2.5-coder:7b',
      displayName: 'qwen2.5-coder:7b',
      provider: 'ollama',
      capabilities: ['chat'],
      tier: 'local',
    });
  }
  return {
    providers: [],
    defaultModel: models[0].id,
    defaultProvider: models[0].provider,
    models,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('resolveModelByTier — local tier (Phase 5)', () => {
  const origFlag = process.env.ANVIL_LOCAL_TIER_ENABLED;

  beforeEach(() => {
    invalidateResolverCache();
  });

  afterEach(() => {
    if (origFlag === undefined) delete process.env.ANVIL_LOCAL_TIER_ENABLED;
    else process.env.ANVIL_LOCAL_TIER_ENABLED = origFlag;
    invalidateResolverCache();
  });

  it('routes fast-tier clarify to a local model when the flag is on and one exists', () => {
    process.env.ANVIL_LOCAL_TIER_ENABLED = '1';
    setDiscoveryResult(makeDiscovery({ withLocal: true }));
    const id = resolveModelByTier('fast', 'clarify', 'claude-haiku-4-5');
    assert.equal(id, 'qwen2.5-coder:7b');
  });

  it('routes fast-tier ship to a local model under the same conditions', () => {
    process.env.ANVIL_LOCAL_TIER_ENABLED = '1';
    setDiscoveryResult(makeDiscovery({ withLocal: true }));
    const id = resolveModelByTier('fast', 'ship', 'claude-haiku-4-5');
    assert.equal(id, 'qwen2.5-coder:7b');
  });

  it('falls back to remote-fast when flag is on but no local model is discovered', () => {
    process.env.ANVIL_LOCAL_TIER_ENABLED = '1';
    setDiscoveryResult(makeDiscovery({ withLocal: false }));
    const id = resolveModelByTier('fast', 'clarify', 'claude-haiku-4-5');
    // Resolver should pick the agentic 'fast' model from the registry.
    assert.equal(id, 'claude-haiku-4-5');
  });

  it('leaves behavior untouched when the flag is off, even if a local model exists', () => {
    delete process.env.ANVIL_LOCAL_TIER_ENABLED;
    setDiscoveryResult(makeDiscovery({ withLocal: true }));
    const id = resolveModelByTier('fast', 'clarify', 'claude-haiku-4-5');
    // Should resolve to the agentic fast-tier model, not Ollama.
    assert.equal(id, 'claude-haiku-4-5');
  });

  it("doesn't escalate non-fast tiers", () => {
    process.env.ANVIL_LOCAL_TIER_ENABLED = '1';
    setDiscoveryResult(makeDiscovery({ withLocal: true }));
    const id = resolveModelByTier('thorough', 'clarify', 'claude-haiku-4-5');
    // 'thorough' tier puts clarify on 'balanced'; should resolve to Sonnet.
    assert.equal(id, 'claude-sonnet-4-6');
  });

  it("doesn't escalate other fast-tier stages (e.g. build) to local", () => {
    process.env.ANVIL_LOCAL_TIER_ENABLED = '1';
    setDiscoveryResult(makeDiscovery({ withLocal: true }));
    const id = resolveModelByTier('fast', 'build', 'claude-haiku-4-5');
    // 'fast' tier maps build → 'balanced'. Should not be the local model.
    assert.equal(id, 'claude-sonnet-4-6');
  });

  it('honors fallback when no discovery result is set', () => {
    invalidateResolverCache(); // also clears lastDiscoveryResult
    process.env.ANVIL_LOCAL_TIER_ENABLED = '1';
    const id = resolveModelByTier('fast', 'clarify', 'fallback-model-id');
    assert.equal(id, 'fallback-model-id');
  });
});
