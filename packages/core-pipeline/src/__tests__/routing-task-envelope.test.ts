// Phase 9 — task envelope schema + validator. (Now in core-pipeline.)

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTaskEnvelope,
  parseTaskEnvelopeArray,
  TaskEnvelopeValidationError,
} from '../routing/task-envelope.js';

const validTask = () => ({
  id: 'T-001',
  repo: 'knowledge-core',
  files_affected: ['src/embed/router.ts'],
  operation: 'modify',
  routing: {
    capability: 'code',
    complexity: 'M',
    context_estimate_tokens: 18000,
  },
  acceptance_criteria: [
    { type: 'predicate', check: 'exports_symbol', file: 'src/embed/router.ts', symbol: 'resolveEmbedder' },
    { type: 'prose', text: 'error messages reference both capability and complexity' },
  ],
});

describe('parseTaskEnvelope — happy path', () => {
  it('accepts a minimal valid envelope', () => {
    const env = parseTaskEnvelope(validTask());
    assert.equal(env.id, 'T-001');
    assert.equal(env.routing.capability, 'code');
    assert.equal(env.acceptance_criteria.length, 2);
  });

  it('accepts optional fields', () => {
    const t = validTask() as Record<string, unknown>;
    Object.assign(t, {
      parent_spec: 'SPEC-7#section-3',
      tests_required: [{ path: 'src/__tests__/x.test.ts', cases: ['happy_path', 'error'] }],
      done_definition: ['all tests pass'],
    });
    const env = parseTaskEnvelope(t);
    assert.equal(env.parent_spec, 'SPEC-7#section-3');
    assert.equal(env.tests_required?.length, 1);
    assert.deepEqual(env.done_definition, ['all tests pass']);
  });

  it('preserves arbitrary predicate args (passthrough)', () => {
    const env = parseTaskEnvelope({
      ...validTask(),
      acceptance_criteria: [
        { type: 'predicate', check: 'contains', file: 'a.ts', regex: '/foo/' },
      ],
    });
    const ac = env.acceptance_criteria[0] as { regex?: string };
    assert.equal(ac.regex, '/foo/');
  });
});

describe('parseTaskEnvelope — required fields', () => {
  it('rejects missing id', () => {
    const t = validTask() as Partial<ReturnType<typeof validTask>>;
    delete t.id;
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects empty files_affected', () => {
    const t = { ...validTask(), files_affected: [] };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects unknown operation', () => {
    const t = { ...validTask(), operation: 'rewrite' };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects unknown routing.capability', () => {
    const t = { ...validTask(), routing: { ...validTask().routing, capability: 'magic' } };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects routing.complexity = XL', () => {
    const t = { ...validTask(), routing: { ...validTask().routing, complexity: 'XL' } };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects non-positive context_estimate_tokens', () => {
    const t = { ...validTask(), routing: { ...validTask().routing, context_estimate_tokens: 0 } };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects empty acceptance_criteria', () => {
    const t = { ...validTask(), acceptance_criteria: [] };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects acceptance criterion with unknown type', () => {
    const t = { ...validTask(), acceptance_criteria: [{ type: 'mystery', text: 'x' }] };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects predicate without check string', () => {
    const t = { ...validTask(), acceptance_criteria: [{ type: 'predicate' }] };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });

  it('rejects prose without text', () => {
    const t = { ...validTask(), acceptance_criteria: [{ type: 'prose' }] };
    assert.throws(() => parseTaskEnvelope(t), TaskEnvelopeValidationError);
  });
});

describe('parseTaskEnvelopeArray', () => {
  it('parses a list', () => {
    const list = parseTaskEnvelopeArray([
      validTask(),
      { ...validTask(), id: 'T-002' },
    ]);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((t) => t.id), ['T-001', 'T-002']);
  });

  it('rejects duplicate ids', () => {
    assert.throws(
      () => parseTaskEnvelopeArray([validTask(), validTask()]),
      TaskEnvelopeValidationError,
    );
  });

  it('rejects non-array input', () => {
    assert.throws(() => parseTaskEnvelopeArray('not-an-array'), TaskEnvelopeValidationError);
  });
});
