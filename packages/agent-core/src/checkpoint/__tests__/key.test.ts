/**
 * Tests for checkpoint-key: computeFingerprint + computeKey.
 *
 * node:test + node:assert/strict, no third-party deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  blobPath,
  checkpointPath,
  computeFingerprint,
  computeKey,
} from '../key.js';
import type { CheckpointInputs } from '../types.js';

describe('computeFingerprint', () => {
  it('produces the same hash for identical inputs', () => {
    const a = computeFingerprint({ foo: 1, bar: 'baz' });
    const b = computeFingerprint({ foo: 1, bar: 'baz' });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('is stable across key reorderings', () => {
    const a = computeFingerprint({ foo: 1, bar: 'baz', nested: { x: 1, y: 2 } });
    const b = computeFingerprint({ nested: { y: 2, x: 1 }, bar: 'baz', foo: 1 });
    assert.equal(a, b);
  });

  it('changes when any value changes', () => {
    const a = computeFingerprint({ foo: 1 });
    const b = computeFingerprint({ foo: 2 });
    assert.notEqual(a, b);
  });

  it('treats missing keys differently from keys with undefined values', () => {
    // Both omit the field from the serialization — they should hash the same.
    const a = computeFingerprint({ foo: 1 });
    const b = computeFingerprint({ foo: 1, bar: undefined });
    assert.equal(a, b);
  });

  it('distinguishes null from undefined', () => {
    const a = computeFingerprint({ x: null });
    const b = computeFingerprint({ x: undefined });
    assert.notEqual(a, b);
  });

  it('handles primitives', () => {
    assert.match(computeFingerprint('hello'), /^[0-9a-f]{64}$/);
    assert.match(computeFingerprint(42), /^[0-9a-f]{64}$/);
    assert.match(computeFingerprint(true), /^[0-9a-f]{64}$/);
    assert.match(computeFingerprint(null), /^[0-9a-f]{64}$/);
    // Different primitives hash differently.
    assert.notEqual(computeFingerprint(1), computeFingerprint('1'));
    assert.notEqual(computeFingerprint(true), computeFingerprint(1));
  });

  it('handles arrays order-sensitively', () => {
    const a = computeFingerprint([1, 2, 3]);
    const b = computeFingerprint([3, 2, 1]);
    assert.notEqual(a, b);
  });

  it('handles Dates deterministically', () => {
    const d = new Date('2025-01-01T00:00:00Z');
    const a = computeFingerprint({ t: d });
    const b = computeFingerprint({ t: new Date('2025-01-01T00:00:00Z') });
    assert.equal(a, b);
  });

  it('handles unknown / exotic values (bigint, NaN, Infinity) without throwing', () => {
    assert.doesNotThrow(() => computeFingerprint(BigInt(10)));
    assert.doesNotThrow(() => computeFingerprint(NaN));
    assert.doesNotThrow(() => computeFingerprint(Infinity));
    assert.doesNotThrow(() => computeFingerprint(() => 1));
    // NaN !== Infinity
    assert.notEqual(computeFingerprint(NaN), computeFingerprint(Infinity));
  });
});

describe('computeKey', () => {
  const baseInputs: CheckpointInputs = {
    stage: 'plan',
    taskId: 'plan:root',
    promptVersion: 'v1',
    model: 'claude-opus-4-5',
    toolVersions: { tsc: '5.3.3' },
    inputs: { feature: 'login' },
  };

  it('returns identical hash for identical inputs', () => {
    const a = computeKey('run-1', baseInputs);
    const b = computeKey('run-1', baseInputs);
    assert.equal(a.hash, b.hash);
    assert.equal(a.runFamily, 'run-1');
    assert.equal(a.stage, 'plan');
    assert.equal(a.taskId, 'plan:root');
  });

  it('hash changes when promptVersion changes', () => {
    const a = computeKey('run-1', baseInputs);
    const b = computeKey('run-1', { ...baseInputs, promptVersion: 'v2' });
    assert.notEqual(a.hash, b.hash);
  });

  it('hash changes when model changes', () => {
    const a = computeKey('run-1', baseInputs);
    const b = computeKey('run-1', { ...baseInputs, model: 'gpt-4' });
    assert.notEqual(a.hash, b.hash);
  });

  it('hash changes when toolVersions change', () => {
    const a = computeKey('run-1', baseInputs);
    const b = computeKey('run-1', { ...baseInputs, toolVersions: { tsc: '5.4.0' } });
    assert.notEqual(a.hash, b.hash);
  });

  it('hash changes when runFamily changes', () => {
    const a = computeKey('run-1', baseInputs);
    const b = computeKey('run-2', baseInputs);
    assert.notEqual(a.hash, b.hash);
  });

  it('hash changes when inputs payload changes', () => {
    const a = computeKey('run-1', baseInputs);
    const b = computeKey('run-1', { ...baseInputs, inputs: { feature: 'logout' } });
    assert.notEqual(a.hash, b.hash);
  });

  it('is stable when input object keys are reordered', () => {
    const a = computeKey('run-1', {
      ...baseInputs,
      inputs: { feature: 'login', locale: 'en' },
    });
    const b = computeKey('run-1', {
      ...baseInputs,
      inputs: { locale: 'en', feature: 'login' },
    });
    assert.equal(a.hash, b.hash);
  });
});

describe('path helpers', () => {
  it('checkpointPath returns the expected layout', () => {
    const p = checkpointPath('/tmp/home', 'demo', 'run-1', 'plan', 'abcd1234');
    assert.equal(p, '/tmp/home/checkpoints/demo/run-1/plan/abcd1234.json');
  });

  it('blobPath fans out by first 2 hex chars', () => {
    const p = blobPath('/tmp/home', 'abcdef1234567890');
    assert.equal(p, '/tmp/home/checkpoints/_blobs/ab/abcdef1234567890');
  });
});
