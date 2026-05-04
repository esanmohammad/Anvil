/**
 * Phase 5 — discovery: provider-level liveness probe → registry.availability.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { discoverAvailability } from '../router/discovery.js';
import type { DiscoveryAdapter, DiscoveryDeps } from '../router/discovery.js';
import { DEFAULT_WALKER_CONFIG } from '../router/model-registry.js';
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
  return { models, walker: { ...DEFAULT_WALKER_CONFIG } };
}

function fakeAdapter(result: { available: boolean; error?: string } | (() => Promise<never>)): DiscoveryAdapter {
  if (typeof result === 'function') {
    return { checkAvailability: result };
  }
  return { checkAvailability: async () => result };
}

describe('discoverAvailability', () => {
  it('marks every model with the result of its provider probe', async () => {
    const r = reg(
      entry({ id: 'qwen', provider: 'ollama' }),
      entry({ id: 'opus', provider: 'claude' }),
    );
    const deps: DiscoveryDeps = {
      getAdapter: (p) => {
        if (p === 'ollama') return fakeAdapter({ available: true });
        if (p === 'claude') return fakeAdapter({ available: false, error: 'no API key' });
        return undefined;
      },
      now: () => 1000,
    };
    await discoverAvailability(r, deps);
    assert.equal(r.availability?.get('qwen')?.available, true);
    assert.equal(r.availability?.get('qwen')?.lastChecked, 1000);
    assert.equal(r.availability?.get('opus')?.available, false);
    assert.equal(r.availability?.get('opus')?.error, 'no API key');
  });

  it('replicates the per-provider probe across all models sharing that provider', async () => {
    const r = reg(
      entry({ id: 'qwen', provider: 'ollama' }),
      entry({ id: 'gemma', provider: 'ollama' }),
    );
    let probeCount = 0;
    const deps: DiscoveryDeps = {
      getAdapter: () => ({
        async checkAvailability() {
          probeCount += 1;
          return { available: true };
        },
      }),
    };
    await discoverAvailability(r, deps);
    assert.equal(probeCount, 1, 'one probe per unique provider');
    assert.equal(r.availability?.get('qwen')?.available, true);
    assert.equal(r.availability?.get('gemma')?.available, true);
  });

  it('marks unavailable when the adapter is not registered', async () => {
    const r = reg(entry({ id: 'rogue', provider: 'openrouter' }));
    const deps: DiscoveryDeps = { getAdapter: () => undefined };
    await discoverAvailability(r, deps);
    const a = r.availability?.get('rogue');
    assert.equal(a?.available, false);
    assert.match(a?.error ?? '', /no adapter/);
  });

  it('marks unavailable when checkAvailability throws', async () => {
    const r = reg(entry({ id: 'q', provider: 'ollama' }));
    const deps: DiscoveryDeps = {
      getAdapter: () => fakeAdapter(async () => {
        throw new Error('connection refused');
      }),
    };
    await discoverAvailability(r, deps);
    const a = r.availability?.get('q');
    assert.equal(a?.available, false);
    assert.match(a?.error ?? '', /connection refused/);
  });

  it('marks unavailable when the probe exceeds the timeout', async () => {
    const r = reg(entry({ id: 'slow', provider: 'ollama' }));
    const deps: DiscoveryDeps = {
      getAdapter: () => ({
        // never resolves
        checkAvailability: () => new Promise(() => {}),
      }),
    };
    const before = Date.now();
    await discoverAvailability(r, deps, { timeoutMs: 50 });
    const after = Date.now();
    assert.ok(after - before < 500, 'should not block on slow probe');
    const a = r.availability?.get('slow');
    assert.equal(a?.available, false);
    assert.match(a?.error ?? '', /timeout/);
  });

  it('preserves the same registry reference (mutates in place)', async () => {
    const r = reg(entry({ id: 'q', provider: 'ollama' }));
    const deps: DiscoveryDeps = {
      getAdapter: () => fakeAdapter({ available: true }),
    };
    const out = await discoverAvailability(r, deps);
    assert.strictEqual(out, r);
    assert.ok(out.availability instanceof Map);
  });

  it('refreshes timestamps on re-run', async () => {
    const r = reg(entry({ id: 'q', provider: 'ollama' }));
    let t = 100;
    const deps: DiscoveryDeps = {
      getAdapter: () => fakeAdapter({ available: true }),
      now: () => t,
    };
    await discoverAvailability(r, deps);
    assert.equal(r.availability?.get('q')?.lastChecked, 100);
    t = 200;
    await discoverAvailability(r, deps);
    assert.equal(r.availability?.get('q')?.lastChecked, 200);
  });

  it('returns immediately on an empty registry', async () => {
    const r: ModelRegistry = { models: [], walker: { ...DEFAULT_WALKER_CONFIG } };
    const deps: DiscoveryDeps = { getAdapter: () => undefined };
    await discoverAvailability(r, deps);
    assert.equal(r.availability?.size, 0);
  });
});
