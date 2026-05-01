// Phase 9 — task envelope schema + validator.

import {
  parseTaskEnvelope,
  parseTaskEnvelopeArray,
  TaskEnvelopeValidationError,
} from '../task-envelope.js';

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
    expect(env.id).toBe('T-001');
    expect(env.routing.capability).toBe('code');
    expect(env.acceptance_criteria).toHaveLength(2);
  });

  it('accepts optional fields', () => {
    const t = validTask();
    Object.assign(t, {
      parent_spec: 'SPEC-7#section-3',
      tests_required: [{ path: 'src/__tests__/x.test.ts', cases: ['happy_path', 'error'] }],
      done_definition: ['all tests pass'],
    });
    const env = parseTaskEnvelope(t);
    expect(env.parent_spec).toBe('SPEC-7#section-3');
    expect(env.tests_required).toHaveLength(1);
    expect(env.done_definition).toEqual(['all tests pass']);
  });

  it('preserves arbitrary predicate args (passthrough)', () => {
    const env = parseTaskEnvelope({
      ...validTask(),
      acceptance_criteria: [
        { type: 'predicate', check: 'contains', file: 'a.ts', regex: '/foo/' },
      ],
    });
    const ac = env.acceptance_criteria[0] as { regex?: string };
    expect(ac.regex).toBe('/foo/');
  });
});

describe('parseTaskEnvelope — required fields', () => {
  it('rejects missing id', () => {
    const t = validTask() as Partial<ReturnType<typeof validTask>>;
    delete t.id;
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects empty files_affected', () => {
    const t = { ...validTask(), files_affected: [] };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects unknown operation', () => {
    const t = { ...validTask(), operation: 'rewrite' };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects unknown routing.capability', () => {
    const t = { ...validTask(), routing: { ...validTask().routing, capability: 'magic' } };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects routing.complexity = XL', () => {
    const t = { ...validTask(), routing: { ...validTask().routing, complexity: 'XL' } };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects non-positive context_estimate_tokens', () => {
    const t = { ...validTask(), routing: { ...validTask().routing, context_estimate_tokens: 0 } };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects empty acceptance_criteria', () => {
    const t = { ...validTask(), acceptance_criteria: [] };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects acceptance criterion with unknown type', () => {
    const t = { ...validTask(), acceptance_criteria: [{ type: 'mystery', text: 'x' }] };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects predicate without check string', () => {
    const t = { ...validTask(), acceptance_criteria: [{ type: 'predicate' }] };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects prose without text', () => {
    const t = { ...validTask(), acceptance_criteria: [{ type: 'prose' }] };
    expect(() => parseTaskEnvelope(t)).toThrow(TaskEnvelopeValidationError);
  });
});

describe('parseTaskEnvelopeArray', () => {
  it('parses a list', () => {
    const list = parseTaskEnvelopeArray([
      validTask(),
      { ...validTask(), id: 'T-002' },
    ]);
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.id)).toEqual(['T-001', 'T-002']);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      parseTaskEnvelopeArray([
        validTask(),
        validTask(), // same id
      ]),
    ).toThrow(TaskEnvelopeValidationError);
  });

  it('rejects non-array input', () => {
    expect(() => parseTaskEnvelopeArray('not-an-array')).toThrow(TaskEnvelopeValidationError);
  });
});
