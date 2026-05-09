/**
 * Phase F5 — context-budget smoke test.
 *
 * Promoted from packages/dashboard/server/context-budget.ts to
 * packages/core-pipeline/src/utils/context-budget.ts. No prior test
 * existed; this suite pins the priority-rule contract documented in the
 * module header so future edits to the truncation/drop logic can't
 * silently regress prompt assembly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBudget,
  budgetPromptContext,
  estimateTokens,
  getModelTokenLimit,
  type ContextComponent,
} from '../utils/context-budget.js';

describe('context-budget — getModelTokenLimit', () => {
  it('routes to model-catalog (1M for Claude Opus 4.6+)', () => {
    assert.equal(getModelTokenLimit('claude-opus-4-6'), 1_000_000);
  });

  it('legacy Sonnet 4.5 returns 200K', () => {
    assert.equal(getModelTokenLimit('claude-sonnet-4-5'), 200_000);
  });
});

describe('context-budget — estimateTokens', () => {
  it('empty string is zero', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('estimates non-zero for non-empty string', () => {
    const t = estimateTokens('a'.repeat(400));
    assert.ok(t > 0);
  });
});

describe('context-budget — applyBudget priority rules', () => {
  const big = (size: number, name: string, priority: number, kind?: 'code' | 'prose'): ContextComponent => ({
    name,
    content: 'x'.repeat(size),
    tokens: Math.ceil(size / 4),
    priority,
    kind,
  });

  it('within budget — returns components verbatim, no warning', () => {
    const components = [big(100, 'desc', 1), big(100, 'kb', 2)];
    const result = applyBudget(components, 'claude-opus-4-6');
    assert.equal(result.warning, null);
    assert.deepEqual(result.truncated, []);
    assert.deepEqual(result.dropped, []);
  });

  it('priority-1 components are NEVER touched, priority-4 are dropped first', () => {
    const components = [
      big(100, 'essential', 1),
      big(800_000, 'kb', 2),
      big(200_000, 'memory', 3),
      big(300_000, 'overrides', 4),
    ];
    const result = applyBudget(components, 'gpt-4o'); // 128K limit — pretty tight

    const essential = result.components.find((c) => c.name === 'essential')!;
    assert.equal(essential.tokens, components[0].tokens, 'essential never touched');

    assert.ok(result.dropped.includes('overrides'), 'priority-4 dropped first');
    assert.ok(result.warning, 'warning produced');
  });

  it('truncates priority-2 to fit (not dropped)', () => {
    const components = [
      big(100, 'essential', 1),
      big(700_000, 'kb', 2, 'prose'),
    ];
    const result = applyBudget(components, 'gpt-4o'); // 128K limit
    const kb = result.components.find((c) => c.name === 'kb')!;
    assert.ok(kb.tokens < components[1].tokens, 'kb was truncated');
    assert.ok(result.truncated.includes('kb'));
  });
});

describe('context-budget — budgetPromptContext', () => {
  it('returns truncated content + totalTokens for each component', () => {
    const out = budgetPromptContext({
      featureDescription: 'x'.repeat(200),
      stagePrompt: 'y'.repeat(200),
      knowledgeBase: 'k'.repeat(2_000_000),
      priorArtifacts: 'p'.repeat(200),
      memory: 'm'.repeat(200),
      projectYaml: 'cfg'.repeat(50),
      overrides: 'o'.repeat(200),
      modelId: 'gpt-4o',
    });
    assert.ok(out.totalTokens > 0);
    assert.ok(out.knowledgeBase.length < 2_000_000, 'KB shrunk to fit');
    assert.equal(out.limit, 128_000);
  });
});
