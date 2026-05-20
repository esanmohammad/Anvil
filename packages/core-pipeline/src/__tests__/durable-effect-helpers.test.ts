/**
 * Phase E0 — `serializeAgentRunResult` + `contentHash` +
 * `artifactIdempotencyKey` round-trip tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeAgentRunResult,
  contentHash,
  artifactIdempotencyKey,
} from '../durable/effect-helpers.js';

describe('serializeAgentRunResult', () => {
  it('preserves canonical AgentRunResult fields', () => {
    const r = {
      output: 'hello',
      tokenEstimate: 100,
      inputTokens: 50,
      outputTokens: 50,
      costUsd: 0.0123,
      stopReason: 'end_turn',
      model: 'claude-3.5-sonnet',
    };
    assert.deepEqual(serializeAgentRunResult(r), r);
  });

  it('drops undefined fields', () => {
    const r = { output: 'hi', transcript: undefined, costUsd: 0.1 };
    assert.deepEqual(serializeAgentRunResult(r), { output: 'hi', costUsd: 0.1 });
  });

  it('converts Set<string> to array', () => {
    const r = { output: 'hi', prUrls: new Set(['https://github.com/a/b/pull/1']) };
    const s = serializeAgentRunResult(r) as Record<string, unknown>;
    assert.deepEqual(s.prUrls, ['https://github.com/a/b/pull/1']);
  });

  it('converts Map to plain object', () => {
    const r = { output: 'hi', headers: new Map([['x', '1'], ['y', '2']]) };
    const s = serializeAgentRunResult(r) as Record<string, unknown>;
    assert.deepEqual(s.headers, { x: '1', y: '2' });
  });

  it('round-trips through JSON cleanly', () => {
    const r = { output: 'hi', tokenEstimate: 1, costUsd: 0 };
    const round = JSON.parse(JSON.stringify(serializeAgentRunResult(r)));
    assert.deepEqual(round, r);
  });
});

describe('contentHash', () => {
  it('returns a 16-char hex by default', () => {
    const h = contentHash('hello');
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('respects custom length', () => {
    assert.equal(contentHash('hello', 8).length, 8);
    assert.equal(contentHash('hello', 32).length, 32);
  });

  it('is deterministic', () => {
    assert.equal(contentHash('foo'), contentHash('foo'));
  });

  it('produces different output for different input', () => {
    assert.notEqual(contentHash('foo'), contentHash('bar'));
  });
});

describe('artifactIdempotencyKey', () => {
  it('produces stage|scope|hash format', () => {
    const k = artifactIdempotencyKey('requirements', 'mono-repo', 'body content');
    const parts = k.split('|');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'requirements');
    assert.equal(parts[1], 'mono-repo');
    assert.equal(parts[2].length, 16);
  });

  it('is stable for the same inputs', () => {
    assert.equal(
      artifactIdempotencyKey('build', 'repo-a', 'task-1 output'),
      artifactIdempotencyKey('build', 'repo-a', 'task-1 output'),
    );
  });
});
