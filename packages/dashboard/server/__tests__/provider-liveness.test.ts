/**
 * Phase 11 — provider-liveness + chain-fallback tests.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickAliveModelFromChain,
  pickAliveModelFromChainSync,
  isProviderAlive,
  setLivenessTtlMs,
  getLivenessTtlMs,
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

  it('opencode alive iff OPENCODE_API_KEY is set', async () => {
    delete process.env.OPENCODE_API_KEY;
    assert.equal(await isProviderAlive('opencode'), false);
    _resetLivenessCache();
    process.env.OPENCODE_API_KEY = 'sk-test';
    assert.equal(await isProviderAlive('opencode'), true);
  });

  it('adk alive iff ANY of ANTHROPIC/GEMINI/GOOGLE_GENAI/GOOGLE keys is set', async () => {
    for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY']) {
      delete process.env[k];
    }
    assert.equal(await isProviderAlive('adk'), false, 'no auth env → dead');

    for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY']) {
      _resetLivenessCache();
      for (const k2 of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY']) {
        delete process.env[k2];
      }
      process.env[k] = 'sk-test';
      assert.equal(await isProviderAlive('adk'), true, `${k} alone should mark adk alive`);
    }
  });

  it('gemini alive on GOOGLE_GENAI_API_KEY (legacy googly key name)', async () => {
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY']) {
      delete process.env[k];
    }
    assert.equal(await isProviderAlive('gemini'), false);
    _resetLivenessCache();
    process.env.GOOGLE_GENAI_API_KEY = 'sk-test';
    assert.equal(await isProviderAlive('gemini'), true);
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

describe('pickAliveModelFromChainSync — excludeModels (burned set)', () => {
  it('skips burned primary, returns next live entry with fellBackFrom set', () => {
    // Simulate primary alive (cache positive) — but it's been burned earlier.
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const burned = new Set(['qwen3:14b']);
    const r = pickAliveModelFromChainSync(chain, providerOf, burned);
    assert.equal(r.model, 'claude-haiku-4-5-20251001');
    assert.equal(r.fellBackFrom, 'qwen3:14b', 'should record where we came from');
  });

  it('walks past multiple burned entries to the first non-burned alive', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const burned = new Set(['qwen3:14b', 'claude-haiku-4-5-20251001']);
    const r = pickAliveModelFromChainSync(chain, providerOf, burned);
    assert.equal(r.model, 'claude-sonnet-4-6');
    assert.equal(r.fellBackFrom, 'qwen3:14b');
  });

  it('returns primary when no entries are burned (cold cache + empty set)', () => {
    const r = pickAliveModelFromChainSync(chain, providerOf, new Set());
    assert.equal(r.model, 'qwen3:14b');
    assert.equal(r.fellBackFrom, undefined);
  });

  it('returns primary as last resort when EVERY chain entry is burned', () => {
    const burned = new Set(['qwen3:14b', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
    const r = pickAliveModelFromChainSync(chain, providerOf, burned);
    // Adapter surfaces the real error; we don't fabricate a "no-providers"
    // shell. Primary returned even though it's burned.
    assert.equal(r.model, 'qwen3:14b');
  });
});

describe('setLivenessTtlMs — walker config integration', () => {
  it('default TTL is 30s', () => {
    _resetLivenessCache();
    assert.equal(getLivenessTtlMs(), 30_000);
  });

  it('honors a custom TTL', () => {
    setLivenessTtlMs(5_000);
    assert.equal(getLivenessTtlMs(), 5_000);
  });

  it('TTL=0 is accepted (disables caching)', () => {
    setLivenessTtlMs(0);
    assert.equal(getLivenessTtlMs(), 0);
  });

  it('rejects negative / non-finite values silently (defensive)', () => {
    setLivenessTtlMs(15_000);
    setLivenessTtlMs(-1);
    assert.equal(getLivenessTtlMs(), 15_000, 'negative ignored');
    setLivenessTtlMs(NaN);
    assert.equal(getLivenessTtlMs(), 15_000, 'NaN ignored');
  });

  it('TTL=0 issues a fresh probe every call (no cache hit)', async () => {
    setLivenessTtlMs(0);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as typeof fetch;
    await isProviderAlive('ollama');
    await isProviderAlive('ollama');
    await isProviderAlive('ollama');
    assert.equal(calls, 3, 'every call hits the network when TTL=0');
  });
});
