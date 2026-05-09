/**
 * Phase F1 — model-catalog smoke test.
 *
 * Promoted from `packages/dashboard/server/model-catalog.ts` to
 * `packages/agent-core/src/model-catalog.ts`. No prior test existed; this
 * suite pins the resolution-order contract documented in the module
 * header so future edits to OVERRIDES / FAMILY_RULES can't silently
 * regress per-model token limits.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SPEC,
  getModelSpec,
  getContextWindow,
  getMaxOutput,
  type ModelSpec,
} from '../model-catalog.js';

describe('model-catalog (Phase F1)', () => {
  describe('family rules — current-generation 1M models', () => {
    it('Claude Opus 4.6+ resolves to 1M / 64k', () => {
      const spec = getModelSpec('claude-opus-4-6');
      assert.equal(spec.contextWindow, 1_000_000);
      assert.equal(spec.maxOutput, 64_000);
    });

    it('Claude Opus 4.7 1M alias resolves to 1M / 64k', () => {
      assert.equal(getContextWindow('claude-opus-4-7[1m]'), 1_000_000);
    });

    it('Claude Sonnet 4.6 resolves to 1M / 64k', () => {
      assert.equal(getContextWindow('claude-sonnet-4-6'), 1_000_000);
    });

    it('Gemini 2.x resolves to 1M', () => {
      assert.equal(getContextWindow('gemini-2.5-flash'), 1_000_000);
    });
  });

  describe('family rules — legacy models', () => {
    it('Claude Haiku stays at 200K', () => {
      const spec = getModelSpec('claude-haiku-4-5');
      assert.equal(spec.contextWindow, 200_000);
      assert.equal(spec.maxOutput, 64_000);
    });

    it('OpenAI o-series at 200K', () => {
      assert.equal(getContextWindow('o3-mini'), 200_000);
      assert.equal(getMaxOutput('o3-mini'), 100_000);
    });

    it('GPT-4 family at 128K', () => {
      assert.equal(getContextWindow('gpt-4o'), 128_000);
    });
  });

  describe('explicit OVERRIDES win over family rules', () => {
    it('claude-sonnet-4-5 stays at 200K despite family default of 1M', () => {
      const spec = getModelSpec('claude-sonnet-4-5');
      assert.equal(spec.contextWindow, 200_000, 'override applied');
    });

    it('claude-opus-4-1-20250805 stays at 200K / 32k', () => {
      const spec = getModelSpec('claude-opus-4-1-20250805');
      assert.equal(spec.contextWindow, 200_000);
      assert.equal(spec.maxOutput, 32_000);
    });
  });

  describe('OpenRouter-style org/model recursion', () => {
    it('anthropic/claude-opus-4-6 resolves to 1M via segment recursion', () => {
      assert.equal(getContextWindow('anthropic/claude-opus-4-6'), 1_000_000);
    });

    it('moonshotai/kimi-k2.6 falls through to DEFAULT (no family match)', () => {
      const spec = getModelSpec('moonshotai/kimi-k2.6');
      assert.deepEqual(spec, DEFAULT_SPEC);
    });
  });

  describe('ENV override has highest priority', () => {
    const KEY = 'ANVIL_CONTEXT_WINDOW_CLAUDE_OPUS_4_6';
    let prior: string | undefined;
    before(() => {
      prior = process.env[KEY];
      process.env[KEY] = '500000';
    });
    after(() => {
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    });

    it('overrides family rule', () => {
      assert.equal(getContextWindow('claude-opus-4-6'), 500_000);
    });

    it('non-numeric env value is ignored', () => {
      const altKey = 'ANVIL_CONTEXT_WINDOW_GPT_4O';
      const altPrior = process.env[altKey];
      process.env[altKey] = 'not-a-number';
      try {
        assert.equal(getContextWindow('gpt-4o'), 128_000, 'falls through to family rule');
      } finally {
        if (altPrior === undefined) delete process.env[altKey];
        else process.env[altKey] = altPrior;
      }
    });
  });

  describe('unknown ids fall through to DEFAULT_SPEC', () => {
    it('completely unknown model returns DEFAULT_SPEC', () => {
      const spec: ModelSpec = getModelSpec('some-future-model-z9');
      assert.deepEqual(spec, DEFAULT_SPEC);
    });
  });
});
