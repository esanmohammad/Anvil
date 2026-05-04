// Phase 9 (deviation fix) — extracting + validating task envelopes
// emitted by the planner stage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractTaskEnvelopes, buildRetryPrompt } from '../routing/extract-task-envelopes.js';

const VALID_TASKS = [
  {
    id: 'T-001',
    repo: 'knowledge-core',
    files_affected: ['src/embed/router.ts'],
    operation: 'create',
    routing: { capability: 'code', complexity: 'M', context_estimate_tokens: 18000 },
    acceptance_criteria: [{ type: 'prose', text: 'returns chunks' }],
  },
];

describe('extractTaskEnvelopes — happy path', () => {
  it('extracts from a fenced ```json``` block', () => {
    const text =
      'Here is the plan:\n\n```json\n' +
      JSON.stringify(VALID_TASKS, null, 2) +
      '\n```\n\nAnd some prose after.';
    const r = extractTaskEnvelopes(text);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.tasks.length, 1);
    if (r.ok) assert.equal(r.tasks[0].id, 'T-001');
  });

  it('extracts from a fenced ```tasks``` alias block', () => {
    const text = '```tasks\n' + JSON.stringify(VALID_TASKS) + '\n```';
    const r = extractTaskEnvelopes(text);
    assert.equal(r.ok, true);
  });

  it('extracts from a raw JSON array body', () => {
    const r = extractTaskEnvelopes(JSON.stringify(VALID_TASKS));
    assert.equal(r.ok, true);
  });

  it('preserves rawJson on success', () => {
    const r = extractTaskEnvelopes('```json\n' + JSON.stringify(VALID_TASKS) + '\n```');
    if (r.ok) {
      const parsed = JSON.parse(r.rawJson);
      assert.equal(parsed[0].id, 'T-001');
    } else {
      assert.fail('expected ok');
    }
  });
});

describe('extractTaskEnvelopes — failure shapes', () => {
  it('reports no-block-found when the response has no JSON', () => {
    const r = extractTaskEnvelopes('Sure, here is a list:\n1. Do X\n2. Do Y');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no-block-found');
  });

  it('reports json-parse-failed for malformed JSON inside a fenced block', () => {
    const r = extractTaskEnvelopes('```json\n{ id: "missing-quotes" }\n```');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'json-parse-failed');
  });

  it('reports validation-failed when JSON parses but envelope is wrong', () => {
    const bad = [{ id: 'T-1' /* missing required fields */ }];
    const r = extractTaskEnvelopes('```json\n' + JSON.stringify(bad) + '\n```');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'validation-failed');
  });

  it('reports validation-failed when complexity is XL', () => {
    const bad = [{
      id: 'T-1', repo: 'r', files_affected: ['x'], operation: 'create',
      routing: { capability: 'code', complexity: 'XL', context_estimate_tokens: 1 },
      acceptance_criteria: [{ type: 'prose', text: 'x' }],
    }];
    const r = extractTaskEnvelopes('```json\n' + JSON.stringify(bad) + '\n```');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'validation-failed');
  });
});

describe('buildRetryPrompt', () => {
  it('produces a non-empty multi-line prompt for each failure shape', () => {
    for (const reason of ['no-block-found', 'json-parse-failed', 'validation-failed'] as const) {
      const p = buildRetryPrompt({ ok: false, reason, detail: 'x' });
      assert.ok(p.length > 50);
      assert.match(p, /TaskEnvelope/);
      assert.match(p, /json/i);
    }
  });
});
