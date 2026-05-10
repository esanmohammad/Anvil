/**
 * H8 — provider-agnostic translator. Verifies the canonical Anvil
 * computer-use spec lands as the right native shape per provider, and
 * that action-translation produces the correct on-the-wire payload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectProvider,
  hasPixelBrowser,
  translateComputerTool,
  translateActionToProvider,
  type ComputerAction,
} from '../computer-use/computer-use-translator.js';
import { createMockComputerRunner } from '../computer-use/docker-runner.js';

describe('detectProvider', () => {
  it('maps Claude families', () => {
    assert.equal(detectProvider('claude-sonnet-4-6'), 'anthropic');
    assert.equal(detectProvider('claude-opus-4-7'), 'anthropic');
    assert.equal(detectProvider('haiku-4-5'), 'anthropic');
  });
  it('maps OpenAI families', () => {
    assert.equal(detectProvider('gpt-4o'), 'openai');
    assert.equal(detectProvider('gpt-4o-cua'), 'openai');
  });
  it('maps Gemini', () => {
    assert.equal(detectProvider('gemini-2.5-flash'), 'gemini');
  });
  it('maps Ollama', () => {
    assert.equal(detectProvider('ollama/llama-3.1-8b'), 'ollama');
  });
  it('falls back to unsupported', () => {
    assert.equal(detectProvider('mystery-model-x'), 'unsupported');
  });
});

describe('hasPixelBrowser', () => {
  it('returns true for vision providers', () => {
    assert.equal(hasPixelBrowser('claude-sonnet-4-6'), true);
    assert.equal(hasPixelBrowser('gpt-4o'), true);
    assert.equal(hasPixelBrowser('gemini-2.5-flash'), true);
  });
  it('returns false for Ollama', () => {
    assert.equal(hasPixelBrowser('ollama/llama-3.1-8b'), false);
  });
  it('returns false for unknown providers', () => {
    assert.equal(hasPixelBrowser('mystery-x'), false);
  });
});

describe('translateComputerTool', () => {
  const spec = { display: { width_px: 1024, height_px: 768 } };
  it('emits Anthropic computer_20251124', () => {
    const r = translateComputerTool(spec, 'claude-sonnet-4-6');
    if (r.provider !== 'anthropic') throw new Error('expected anthropic');
    assert.equal(r.schema.type, 'computer_20251124');
    assert.equal(r.schema.display_width_px, 1024);
    assert.equal(r.schema.display_height_px, 768);
  });
  it('emits OpenAI computer_use_preview', () => {
    const r = translateComputerTool(spec, 'gpt-4o');
    if (r.provider !== 'openai') throw new Error('expected openai');
    assert.equal(r.schema.type, 'computer_use_preview');
    assert.equal(r.schema.environment, 'browser');
  });
  it('emits Gemini computer tool', () => {
    const r = translateComputerTool(spec, 'gemini-2.5-flash');
    if (r.provider !== 'gemini') throw new Error('expected gemini');
    assert.equal(r.schema.name, 'computer');
  });
  it('returns unsupported for Ollama', () => {
    const r = translateComputerTool(spec, 'ollama/llama-3.1-8b');
    assert.equal(r.provider, 'unsupported');
    assert.equal(r.schema, null);
  });
});

describe('translateActionToProvider', () => {
  it('maps Anvil click→Anthropic left_click', () => {
    const a: ComputerAction = { action: 'click', coordinate: [10, 20] };
    const r = translateActionToProvider(a, 'anthropic') as { action: string; coordinate: number[] };
    assert.equal(r.action, 'left_click');
    assert.deepEqual(r.coordinate, [10, 20]);
  });

  it('maps Anvil click+button=right→Anthropic right_click', () => {
    const a: ComputerAction = { action: 'click', coordinate: [10, 20], button: 'right' };
    const r = translateActionToProvider(a, 'anthropic') as { action: string };
    assert.equal(r.action, 'right_click');
  });

  it('maps Anvil scroll→OpenAI pixel deltas', () => {
    const a: ComputerAction = { action: 'scroll', coordinate: [10, 20], direction: 'down', amount: 3 };
    const r = translateActionToProvider(a, 'openai') as { x: number; y: number; scroll_x: number; scroll_y: number };
    assert.equal(r.x, 10);
    assert.equal(r.y, 20);
    assert.equal(r.scroll_y, 300);
    assert.equal(r.scroll_x, 0);
  });
});

describe('createMockComputerRunner', () => {
  it('returns a 1×1 PNG screenshot for any action', async () => {
    const runner = createMockComputerRunner();
    const r = await runner.do({ action: 'screenshot' });
    assert.equal(r.width, 1);
    assert.equal(r.height, 1);
    assert.match(r.imageBase64 ?? '', /^iVBORw0KGgo/);
  });
});
