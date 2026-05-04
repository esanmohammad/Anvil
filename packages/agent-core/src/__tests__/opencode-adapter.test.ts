/**
 * OpenCode Go adapter — verifies the prefix-stripping + auth wiring on
 * top of the inherited agentic OpenAI loop. Doesn't re-test the loop
 * itself (covered by the OpenRouter agentic suite).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { OpenCodeAdapter } from '../opencode-adapter.js';
import { resolveProvider } from '../agent/session/default-adapter-factory.js';
import type { ModelAdapterConfig } from '../types.js';

function sseFinal(text: string): Response {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 5, cost: 0.00021 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(lines.join(''), { status: 200 });
}

class StubWritable {
  chunks: string[] = [];
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }
  end(): void { /* noop */ }
  on(): void { /* noop */ }
}

const baseConfig: ModelAdapterConfig = {
  userPrompt: 'hi',
  model: 'opencode/qwen3.5-plus',
  workingDir: '/tmp',
  stage: 'build',
  persona: 'engineer',
};

let originalFetch: typeof fetch;
let originalKey: string | undefined;
before(() => {
  originalFetch = globalThis.fetch;
  originalKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'oc_test_key_xyz';
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalKey;
});

describe('OpenCodeAdapter — config', () => {
  it('reports provider="opencode"', () => {
    const a = new OpenCodeAdapter();
    assert.equal(a.provider, 'opencode');
  });

  it('inherits the agentic capability tier', () => {
    const a = new OpenCodeAdapter();
    assert.equal(a.capabilities.tier, 'agentic');
    assert.equal(a.capabilities.toolUse, true);
    assert.equal(a.capabilities.fileSystem, true);
  });

  it('supportsModel only matches opencode/* prefix', () => {
    const a = new OpenCodeAdapter();
    assert.equal(a.supportsModel('opencode/qwen3.5-plus'), true);
    assert.equal(a.supportsModel('anthropic/claude-sonnet-4-6'), false, 'plain OpenRouter slug is NOT ours');
    assert.equal(a.supportsModel('qwen3:14b'), false, 'Ollama-style id is NOT ours');
  });

  it('returns pricing for known models, null for unknown', () => {
    const a = new OpenCodeAdapter();
    assert.deepEqual(a.getModelPricing('opencode/qwen3.5-plus'), [0.05, 0.2]);
    assert.deepEqual(a.getModelPricing('opencode/glm-5.1'), [0.6, 2.4]);
    assert.equal(a.getModelPricing('opencode/some-future-model'), null);
  });

  it('checkAvailability fails clean when OPENCODE_API_KEY is missing', async () => {
    delete process.env.OPENCODE_API_KEY;
    const a = new OpenCodeAdapter();
    const r = await a.checkAvailability();
    assert.equal(r.available, false);
    assert.match(r.error!, /OPENCODE_API_KEY is not set/);
    process.env.OPENCODE_API_KEY = 'oc_test_key_xyz';
  });
});

describe('OpenCodeAdapter — prefix stripping + endpoint', () => {
  it('strips `opencode/` prefix before POSTing to upstream', async () => {
    let observedBody: string | undefined;
    let observedUrl: string | undefined;
    let observedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      observedUrl = url;
      observedBody = init?.body as string;
      observedHeaders = init?.headers as Record<string, string>;
      return sseFinal('hello');
    }) as typeof fetch;

    const a = new OpenCodeAdapter();
    await a.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream);

    assert.equal(observedUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
    const body = JSON.parse(observedBody as string);
    assert.equal(body.model, 'qwen3.5-plus', 'prefix stripped');
    assert.match(observedHeaders!['Authorization'], /^Bearer oc_test_key_xyz/);
    assert.equal(observedHeaders!['X-Title'], 'Anvil');
    assert.equal(observedHeaders!['HTTP-Referer'], undefined, 'OpenRouter-only header omitted');
  });

  it('honors OPENCODE_BASE_URL override', async () => {
    let observedUrl: string | undefined;
    process.env.OPENCODE_BASE_URL = 'https://eu.opencode.ai/zen/go/v1';
    globalThis.fetch = (async (url: string) => {
      observedUrl = url;
      return sseFinal('ok');
    }) as typeof fetch;

    const a = new OpenCodeAdapter();
    await a.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream);

    assert.equal(observedUrl, 'https://eu.opencode.ai/zen/go/v1/chat/completions');
    delete process.env.OPENCODE_BASE_URL;
  });

  it('re-stamps result.provider as "opencode" + retains prefixed model id', async () => {
    globalThis.fetch = (async () => sseFinal('ok')) as typeof fetch;
    const a = new OpenCodeAdapter();
    const r = await a.run({ ...baseConfig }, new StubWritable() as unknown as NodeJS.WritableStream);

    assert.equal(r.provider, 'opencode', 'not openrouter');
    assert.equal(r.model, 'opencode/qwen3.5-plus', 'prefixed id preserved for telemetry');
  });

  it('tolerates a non-prefixed model id (passes straight through)', async () => {
    globalThis.fetch = (async () => sseFinal('ok')) as typeof fetch;
    const a = new OpenCodeAdapter();
    const r = await a.run(
      { ...baseConfig, model: 'qwen3.5-plus' },
      new StubWritable() as unknown as NodeJS.WritableStream,
    );
    // No prefix means we don't re-stamp — provider/model report whatever
    // the parent set. Acceptable since this is the safety-net path.
    assert.ok(r.output === 'ok');
  });
});

describe('default-adapter-factory.resolveProvider — opencode routing', () => {
  it('routes opencode/* ids to the opencode provider', () => {
    assert.equal(resolveProvider('opencode/qwen3.5-plus'), 'opencode');
    assert.equal(resolveProvider('opencode/glm-5.1'), 'opencode');
  });

  it('still routes other slash-format ids to openrouter', () => {
    assert.equal(resolveProvider('anthropic/claude-sonnet-4-6'), 'openrouter');
    assert.equal(resolveProvider('openai/gpt-4o'), 'openrouter');
  });
});
