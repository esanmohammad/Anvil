/**
 * Tests for prompt-budget: enforceBudget + estimateBudgetTokens.
 *
 * node:test + node:assert/strict, no third-party deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enforceBudget,
  estimateBudgetTokens,
  type PromptSection,
} from '../prompt-budget.js';

describe('enforceBudget — under budget', () => {
  it('returns all sections in input order with trimmed=false', () => {
    const sections: PromptSection[] = [
      { id: 'a', text: 'hello', priority: 1 },
      { id: 'b', text: 'world', priority: 2 },
      { id: 'c', text: '!!!', priority: 0 },
    ];
    const r = enforceBudget(sections, { maxBytes: 1000 });
    assert.equal(r.trimmed, false);
    assert.equal(r.text, 'hello\n\nworld\n\n!!!');
    assert.equal(r.decisions.length, 3);
    assert.deepEqual(
      r.decisions.map((d) => d.action),
      ['kept', 'kept', 'kept'],
    );
    assert.deepEqual(
      r.decisions.map((d) => d.id),
      ['a', 'b', 'c'],
    );
  });
});

describe('enforceBudget — over budget', () => {
  it('drops the lowest-priority section, preserves output order', () => {
    const sections: PromptSection[] = [
      { id: 'low', text: 'X'.repeat(60), priority: 1 },
      { id: 'high', text: 'Y'.repeat(60), priority: 10 },
      { id: 'mid', text: 'Z'.repeat(60), priority: 5 },
    ];
    // Total raw: 180 + 4 separator bytes = 184. Cap at 130 forces drop of `low`.
    const r = enforceBudget(sections, { maxBytes: 130, emitMarkers: false });
    assert.equal(r.trimmed, true);
    const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
    assert.equal(byId.high, 'kept');
    assert.equal(byId.mid, 'kept');
    assert.equal(byId.low, 'dropped');
    // Order preserved in decisions.
    assert.deepEqual(
      r.decisions.map((d) => d.id),
      ['low', 'high', 'mid'],
    );
    // Output order: high section appears before mid in source order.
    const idxHigh = r.text.indexOf('Y');
    const idxMid = r.text.indexOf('Z');
    assert.ok(idxHigh >= 0 && idxMid >= 0 && idxHigh < idxMid);
  });
});

describe('enforceBudget — truncatable', () => {
  it('truncates the boundary section with marker', () => {
    const big = 'A'.repeat(2000);
    const sections: PromptSection[] = [
      { id: 'keep', text: 'B'.repeat(100), priority: 10 },
      { id: 'big', text: big, priority: 5, truncatable: true },
      { id: 'low', text: 'C'.repeat(50), priority: 1 },
    ];
    const r = enforceBudget(sections, { maxBytes: 1300, minTruncatedBytes: 500 });
    assert.equal(r.trimmed, true);
    const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d]));
    assert.equal(byId.keep.action, 'kept');
    assert.equal(byId.big.action, 'truncated');
    assert.equal(byId.low.action, 'dropped');
    assert.ok(byId.big.finalBytes < byId.big.originalBytes);
    assert.match(r.text, /\.\.\. \[truncated, \d+ more bytes\]/);
    // Kept+truncated content fits the cap (markers for dropped sections are metadata).
    assert.ok(byId.keep.finalBytes + byId.big.finalBytes <= 1300);
  });
});

describe('enforceBudget — truncatable below floor', () => {
  it('drops a truncatable section when remaining budget < minTruncatedBytes', () => {
    const sections: PromptSection[] = [
      { id: 'fat', text: 'A'.repeat(900), priority: 10 },
      { id: 'trunc', text: 'B'.repeat(2000), priority: 5, truncatable: true },
    ];
    // Remaining after fat (900 + 2 sep) is ~98 bytes — well below 500 floor.
    const r = enforceBudget(sections, { maxBytes: 1000, minTruncatedBytes: 500 });
    assert.equal(r.trimmed, true);
    const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
    assert.equal(byId.fat, 'kept');
    assert.equal(byId.trunc, 'dropped');
  });
});

describe('enforceBudget — multiple truncatable + droppable', () => {
  it('only the highest-priority truncatable that fits is kept-with-truncation', () => {
    const sections: PromptSection[] = [
      { id: 'must', text: 'M'.repeat(400), priority: 100 },
      { id: 't1', text: 'A'.repeat(2000), priority: 50, truncatable: true },
      { id: 't2', text: 'B'.repeat(2000), priority: 40, truncatable: true },
      { id: 'd1', text: 'C'.repeat(500), priority: 30 },
    ];
    const r = enforceBudget(sections, {
      maxBytes: 1200,
      minTruncatedBytes: 300,
      emitMarkers: false,
    });
    const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
    assert.equal(byId.must, 'kept');
    assert.equal(byId.t1, 'truncated');
    assert.equal(byId.t2, 'dropped');
    assert.equal(byId.d1, 'dropped');
    assert.ok(r.bytes <= 1200);
  });
});

describe('enforceBudget — emitMarkers=false', () => {
  it('produces no markers but decisions still report status', () => {
    const sections: PromptSection[] = [
      { id: 'keep', text: 'K'.repeat(50), priority: 10 },
      { id: 'drop', text: 'D'.repeat(200), priority: 1 },
    ];
    const r = enforceBudget(sections, { maxBytes: 60, emitMarkers: false });
    assert.equal(r.trimmed, true);
    assert.doesNotMatch(r.text, /omitted — over budget/);
    assert.doesNotMatch(r.text, /\[truncated/);
    const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
    assert.equal(byId.keep, 'kept');
    assert.equal(byId.drop, 'dropped');
  });
});

describe('enforceBudget — priority ties', () => {
  it('breaks ties by input order: earlier wins', () => {
    const sections: PromptSection[] = [
      { id: 'first', text: 'F'.repeat(60), priority: 5 },
      { id: 'second', text: 'S'.repeat(60), priority: 5 },
    ];
    // Only one fits in 70 bytes. Earlier (first) should be kept.
    const r = enforceBudget(sections, { maxBytes: 70, emitMarkers: false });
    const byId = Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
    assert.equal(byId.first, 'kept');
    assert.equal(byId.second, 'dropped');
  });
});

describe('estimateBudgetTokens', () => {
  it('returns a positive integer for non-empty input', () => {
    const n = estimateBudgetTokens('hello world this is a prompt');
    assert.equal(Number.isInteger(n), true);
    assert.ok(n > 0);
  });
});
