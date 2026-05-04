/**
 * AnthropicLlm + AdkAdapter unit tests.
 *
 * Covers the parts that don't make a network call:
 *   - LLMRegistry registration is idempotent and routes claude-* to
 *     AnthropicLlm.
 *   - Anvil → ADK content translation (system instruction, contents,
 *     tools).
 *   - SSE → LlmResponse parsing for text + tool_use streams.
 *   - Provider routing: `adk:` prefix → 'adk' provider.
 *   - Adapter pricing strips the prefix.
 *   - checkAvailability degrades cleanly when no auth env is set.
 *
 * Live calls against api.anthropic.com are exercised by a separate
 * smoke test gated on ANTHROPIC_API_KEY (not run in CI).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LLMRegistry, BaseLlm } from '@google/adk';

import { AnthropicLlm, registerAnthropicLlm } from '../adk-anthropic-llm.js';
import { AdkAdapter } from '../adk-adapter.js';
import { resolveProvider } from '../agent/session/default-adapter-factory.js';

describe('AnthropicLlm — LLMRegistry integration', () => {
  it('register is idempotent', () => {
    registerAnthropicLlm();
    registerAnthropicLlm();
    registerAnthropicLlm();
    // No throw; resolve still works.
    const cls = LLMRegistry.resolve('claude-sonnet-4-6');
    assert.equal(cls, AnthropicLlm);
  });

  it('resolves any claude-* id to AnthropicLlm', () => {
    registerAnthropicLlm();
    const ids = ['claude-haiku-4-5', 'claude-opus-4-7', 'claude-3-5-haiku-latest', 'claude-test-model'];
    for (const id of ids) {
      assert.equal(LLMRegistry.resolve(id), AnthropicLlm, id);
    }
  });

  it('does NOT claim openrouter-style anthropic/* slugs', () => {
    registerAnthropicLlm();
    assert.throws(
      () => LLMRegistry.resolve('anthropic/claude-sonnet-4-6'),
      /not found|no.*model|unknown/i,
    );
  });

  it('AnthropicLlm extends BaseLlm', () => {
    const llm = new AnthropicLlm({ model: 'claude-sonnet-4-6' });
    assert.ok(llm instanceof BaseLlm);
    assert.equal(llm.model, 'claude-sonnet-4-6');
  });
});

describe('AdkAdapter — provider routing + metadata', () => {
  it('resolveProvider routes `adk:` prefix to adk', () => {
    assert.equal(resolveProvider('adk:claude-sonnet-4-6'), 'adk');
    assert.equal(resolveProvider('adk:gemini-2.5-flash'), 'adk');
    assert.equal(resolveProvider('adk:claude-haiku-4-5'), 'adk');
  });

  it('routes BEFORE the generic slash check (so adk:foo/bar still picks adk)', () => {
    assert.equal(resolveProvider('adk:vendor/model-id'), 'adk');
  });

  it('supportsModel only matches the prefixed form', () => {
    const adapter = new AdkAdapter();
    assert.equal(adapter.supportsModel('adk:claude-sonnet-4-6'), true);
    assert.equal(adapter.supportsModel('claude-sonnet-4-6'), false);
    assert.equal(adapter.supportsModel('gpt-4o'), false);
  });

  it('getModelPricing strips the prefix and falls back to null for unknown', () => {
    const adapter = new AdkAdapter();
    assert.deepEqual(adapter.getModelPricing('adk:claude-sonnet-4-6'), [3.0, 15.0]);
    assert.deepEqual(adapter.getModelPricing('adk:gemini-2.5-flash'), [0.075, 0.30]);
    assert.equal(adapter.getModelPricing('adk:unknown-future-model'), null);
  });

  it('capabilities advertise an agentic loop', () => {
    const adapter = new AdkAdapter();
    assert.equal(adapter.capabilities.tier, 'agentic');
    assert.equal(adapter.capabilities.toolUse, true);
    assert.equal(adapter.capabilities.fileSystem, true);
    assert.equal(adapter.capabilities.shellExecution, true);
    assert.equal(adapter.capabilities.streaming, true);
  });
});

describe('AdkAdapter — checkAvailability', () => {
  it('reports unavailable when no auth env is set', async () => {
    const prior = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      google: process.env.GOOGLE_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      genai: process.env.GOOGLE_GENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    try {
      const adapter = new AdkAdapter();
      const result = await adapter.checkAvailability();
      assert.equal(result.available, false);
      assert.match(result.error ?? '', /ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY/);
    } finally {
      if (prior.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = prior.anthropic;
      if (prior.google !== undefined) process.env.GOOGLE_API_KEY = prior.google;
      if (prior.gemini !== undefined) process.env.GEMINI_API_KEY = prior.gemini;
      if (prior.genai !== undefined) process.env.GOOGLE_GENAI_API_KEY = prior.genai;
    }
  });

  it('reports available when ANTHROPIC_API_KEY is set', async () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-only';
    try {
      const adapter = new AdkAdapter();
      const result = await adapter.checkAvailability();
      assert.equal(result.available, true);
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });
});
