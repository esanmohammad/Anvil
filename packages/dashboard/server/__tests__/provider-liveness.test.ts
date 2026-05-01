/**
 * Phase 11 — provider-liveness + chain-fallback tests.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickAliveModelFromChain,
  isProviderAlive,
  _resetLivenessCache,
} from '../provider-liveness.js';
import type { ResolvedChain } from '@anvil/agent-core';

const origFetch = globalThis.fetch;
const origEnv = { ...process.env };

beforeEach(() => {
  _resetLivenessCache();
});

after(() => {
  globalThis.fetch = origFetch;
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v as string;
});

const chain: ResolvedChain = {
  primary: 'qwen3:14b',
  fallbacks: [
    { model: 'claude-haiku-4-5-20251001' },
    { model: 'claude-sonnet-4-6' },
  ],
};
const providerOf = (id: string) => (id.startsWith('claude') ? 'claude' : 'ollama') as 'claude' | 'ollama';

describe('isProviderAlive — probes + caching', () => {
  it('reports ollama alive when /api/tags returns 200', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    assert.equal(await isProviderAlive('ollama'), true);
  });

  it('reports ollama dead when fetch throws', async () => {
    globalThis.fetch = (async () => { throw new Error('refused'); }) as typeof fetch;
    assert.equal(await isProviderAlive('ollama'), false);
  });

  it('caches positive results within the TTL', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as typeof fetch;
    await isProviderAlive('ollama');
    await isProviderAlive('ollama');
    await isProviderAlive('ollama');
    assert.equal(calls, 1, 'second/third probes hit cache');
  });

  it('claude alive iff ANTHROPIC_API_KEY is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(await isProviderAlive('claude'), false);
    _resetLivenessCache();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal(await isProviderAlive('claude'), true);
  });
});

describe('pickAliveModelFromChain', () => {
  it('returns primary when its provider is alive', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const r = await pickAliveModelFromChain(chain, providerOf);
    assert.equal(r.model, 'qwen3:14b');
    assert.equal(r.provider, 'ollama');
    assert.equal(r.fellBackFrom, undefined);
  });

  it('walks past dead primary to alive fallback', async () => {
    globalThis.fetch = (async () => { throw new Error('Ollama down'); }) as typeof fetch;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const r = await pickAliveModelFromChain(chain, providerOf);
    assert.equal(r.model, 'claude-haiku-4-5-20251001');
    assert.equal(r.provider, 'claude');
    assert.equal(r.fellBackFrom, 'qwen3:14b');
  });

  it('returns primary anyway when nothing in the chain is alive (adapter surfaces real error)', async () => {
    globalThis.fetch = (async () => { throw new Error('Ollama down'); }) as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;
    const r = await pickAliveModelFromChain(chain, providerOf);
    assert.equal(r.model, 'qwen3:14b');
    assert.equal(r.fellBackFrom, undefined);
  });
});
