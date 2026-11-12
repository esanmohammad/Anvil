/**
 * API transport (ANVIL_LLM_MODE=api): which model id reaches the provider.
 * fetch is stubbed — no network.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runClaude, getLlmModel, resetLlmConfig } from '@esankhan3/anvil-agent-core';

const ENV_KEYS = [
  'ANVIL_LLM_MODE', 'ANVIL_LLM_PROVIDER', 'ANVIL_LLM_MODEL', 'ANVIL_LLM_API_KEY', 'ANVIL_LLM_BASE_URL', 'ANVIL_LLM_HEADERS',
  'CODE_SEARCH_LLM_MODE', 'CODE_SEARCH_LLM_PROVIDER', 'CODE_SEARCH_LLM_MODEL', 'CODE_SEARCH_LLM_API_KEY', 'CODE_SEARCH_LLM_BASE_URL',
];

describe('single-shot API transport model id', () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  let calls: Array<{ url: string; model: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.ANVIL_LLM_MODE = 'api';
    process.env.ANVIL_LLM_API_KEY = 'k';
    resetLlmConfig();
    calls = [];
    globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, model: JSON.parse(init.body).model, headers: init.headers });
      // One body both response parsers accept (Anthropic `content`, OpenAI `choices`).
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        choices: [{ message: { content: 'ok' } }],
        usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetLlmConfig();
  });

  it('the default model reaches Anthropic as a real model id, not the short alias', async () => {
    assert.equal(getLlmModel(), 'sonnet');
    await runClaude('p', 's');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].model, 'claude-sonnet-4-6');
  });

  it('a configured model is reported and sent as is', async () => {
    process.env.ANVIL_LLM_MODEL = 'claude-sonnet-5';
    resetLlmConfig();
    assert.equal(getLlmModel(), 'claude-sonnet-5');
    await runClaude('p', 's');
    assert.equal(calls[0].model, 'claude-sonnet-5');
  });

  it('ANVIL_LLM_HEADERS go out with the request, without replacing its own auth', async () => {
    process.env.ANVIL_LLM_PROVIDER = 'openai-compatible';
    process.env.ANVIL_LLM_BASE_URL = 'https://gateway.example';
    process.env.ANVIL_LLM_HEADERS = 'CF-Access-Client-Id=id.access, CF-Access-Client-Secret=s3cr=t,Authorization=other';
    resetLlmConfig();
    await runClaude('p', 's');
    assert.equal(calls[0].url, 'https://gateway.example/v1/chat/completions');
    assert.equal(calls[0].headers['CF-Access-Client-Id'], 'id.access');
    assert.equal(calls[0].headers['CF-Access-Client-Secret'], 's3cr=t');
    assert.equal(calls[0].headers.Authorization, 'Bearer k');
  });
});
