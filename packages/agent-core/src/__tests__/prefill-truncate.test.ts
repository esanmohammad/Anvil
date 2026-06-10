/**
 * §2.3.3 context-window truncation policy — unit tests.
 *
 * Uses the `maxInputTokensFor` override so the budget math is deterministic
 * and independent of the live cost table.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { truncatePrefillForBudget } from '../prefill/truncate.js';
import type { Prefill } from '../turn-recorder/types.js';

function prefillWith(toolCount: number, text: string): Prefill {
  return {
    turnUuid: 'u',
    text,
    sourceProvider: 'openrouter',
    sourceModel: 'a',
    sourceTokens: Math.ceil(text.length / 4),
    toolUses: Array.from({ length: toolCount }, (_, i) => ({
      id: `tc-${i}`,
      name: 'bash',
      input: { cmd: `echo ${i}` },
      result: { toolUseId: `tc-${i}`, toolName: 'bash', ok: true, content: 'x'.repeat(40) },
      producedBy: 'openrouter' as const,
    })),
  };
}

describe('truncatePrefillForBudget (§2.3.3)', () => {
  it('returns the prefill unchanged when it fits the target window', () => {
    const prefill = prefillWith(5, 'short partial');
    const out = truncatePrefillForBudget({
      prefill,
      targetModel: 'big',
      maxInputTokensFor: () => 200_000,
    });
    assert.ok(out, 'fits');
    assert.equal(out!.toolUses.length, 5, 'no tools dropped');
    assert.strictEqual(out, prefill, 'returned as-is (same reference) when it fits');
  });

  it('drops the OLDEST tool pairs (preserving the most recent) to fit a tight budget', () => {
    const prefill = prefillWith(10, 'x'.repeat(400)); // sourceTokens ≈ 100
    // Budget for tools = max - margin - base - sourceTokens.
    // Give just enough window that a few tools fit but not all 10.
    const out = truncatePrefillForBudget({
      prefill,
      targetModel: 'snug',
      marginTokens: 0,
      maxInputTokensFor: () => 130, // 130 - 0 - 0 - 100 = 30 tokens for tools
      estimateTokens: (t) => Math.ceil(t.length / 4),
    });
    assert.ok(out, 'partial text alone fits, so a (trimmed) prefill is returned');
    assert.ok(out!.toolUses.length < 10, 'some tools dropped');
    assert.ok(out!.toolUses.length >= 0);
    if (out!.toolUses.length > 0) {
      // Most-recent tool is preserved (drop from the front).
      assert.equal(out!.toolUses.at(-1)!.id, 'tc-9', 'newest tool kept');
    }
  });

  it('returns undefined (cannot serve) when the partial text alone overflows the window', () => {
    const prefill = prefillWith(0, 'x'.repeat(400_000)); // sourceTokens ≈ 100k
    const out = truncatePrefillForBudget({
      prefill,
      targetModel: 'tiny',
      marginTokens: 8_000,
      maxInputTokensFor: () => 32_000, // 32k - 8k - 100k < 0
    });
    assert.equal(out, undefined, 'walker must retry the next model WITHOUT a prefill');
  });

  it('defaults to the 32K floor when the target model is absent from the price table', () => {
    // No maxInputTokensFor override → falls through to cost.ts which
    // returns undefined for an unknown id → DEFAULT_MAX_INPUT_TOKENS (32K).
    const prefill = prefillWith(0, 'x'.repeat(400_000)); // ≈100k source tokens
    const out = truncatePrefillForBudget({ prefill, targetModel: 'totally-unknown-model-xyz' });
    assert.equal(out, undefined, '100k partial cannot fit the 32K default floor');
  });
});
