/**
 * Tests for the policy patch validator + overlay deep-merge.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePolicyPatch,
  deepMergeOverlay,
} from '../pipeline-policy-validate.js';

describe('validatePolicyPatch', () => {
  it('accepts an empty patch', () => {
    assert.deepEqual(validatePolicyPatch({}), { ok: true });
  });

  it('rejects non-object patches', () => {
    assert.equal(validatePolicyPatch(null).ok, false);
    assert.equal(validatePolicyPatch('').ok, false);
    assert.equal(validatePolicyPatch(42).ok, false);
  });

  it('accepts boolean enabled', () => {
    assert.deepEqual(validatePolicyPatch({ enabled: true }), { ok: true });
    assert.deepEqual(validatePolicyPatch({ enabled: false }), { ok: true });
  });

  it('rejects non-boolean enabled', () => {
    const r = validatePolicyPatch({ enabled: 'yes' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /enabled/);
  });

  it('accepts a valid pauseAfter list', () => {
    const r = validatePolicyPatch({ defaults: { pauseAfter: ['plan', 'implement'] } });
    assert.deepEqual(r, { ok: true });
  });

  it('rejects an unknown stage in pauseAfter', () => {
    const r = validatePolicyPatch({ defaults: { pauseAfter: ['plan', 'foo' as never] } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Unknown stage: foo/);
  });

  it('rejects autoApproveIfRisk with an invalid value', () => {
    const r = validatePolicyPatch({ defaults: { autoApproveIfRisk: 'high' as never } });
    assert.equal(r.ok, false);
  });

  it('rejects autoApproveIfConfidence outside [0, 1]', () => {
    assert.equal(validatePolicyPatch({ defaults: { autoApproveIfConfidence: -0.1 } }).ok, false);
    assert.equal(validatePolicyPatch({ defaults: { autoApproveIfConfidence: 1.1 } }).ok, false);
    assert.deepEqual(validatePolicyPatch({ defaults: { autoApproveIfConfidence: 0 } }), { ok: true });
    assert.deepEqual(validatePolicyPatch({ defaults: { autoApproveIfConfidence: 1 } }), { ok: true });
  });

  it('rejects cost.graceWindowSeconds outside [10, 600]', () => {
    assert.equal(validatePolicyPatch({ cost: { graceWindowSeconds: 5 } }).ok, false);
    assert.equal(validatePolicyPatch({ cost: { graceWindowSeconds: 700 } }).ok, false);
    assert.deepEqual(validatePolicyPatch({ cost: { graceWindowSeconds: 60 } }), { ok: true });
  });

  it('rejects negative cost limits', () => {
    assert.equal(validatePolicyPatch({ cost: { limits: { perRun: -1 } } }).ok, false);
    assert.equal(validatePolicyPatch({ cost: { limits: { perProjectDaily: -1 } } }).ok, false);
  });

  it('accepts valid per-stage cost limits', () => {
    const r = validatePolicyPatch({ cost: { limits: { perStage: { plan: 1, implement: 5 } } } });
    assert.deepEqual(r, { ok: true });
  });

  it('rejects unknown stage in per-stage cost limits', () => {
    const r = validatePolicyPatch({ cost: { limits: { perStage: { foo: 1 } as never } } });
    assert.equal(r.ok, false);
  });

  it('rejects notifications.timeoutHours outside [0.25, 168]', () => {
    assert.equal(validatePolicyPatch({ notifications: { timeoutHours: 0 } }).ok, false);
    assert.equal(validatePolicyPatch({ notifications: { timeoutHours: 200 } }).ok, false);
    assert.deepEqual(validatePolicyPatch({ notifications: { timeoutHours: 4 } }), { ok: true });
  });

  it('rejects qa.maxQuestionsPerStage outside [0, 20]', () => {
    assert.equal(validatePolicyPatch({ qa: { maxQuestionsPerStage: -1 } }).ok, false);
    assert.equal(validatePolicyPatch({ qa: { maxQuestionsPerStage: 21 } }).ok, false);
    assert.equal(validatePolicyPatch({ qa: { maxQuestionsPerStage: 1.5 } }).ok, false);
    assert.deepEqual(validatePolicyPatch({ qa: { maxQuestionsPerStage: 5 } }), { ok: true });
  });
});

describe('deepMergeOverlay', () => {
  it('merges top-level scalars', () => {
    const out = deepMergeOverlay({ enabled: true }, { enabled: false });
    assert.equal(out.enabled, false);
  });

  it('merges defaults shallowly without dropping prior keys', () => {
    const out = deepMergeOverlay(
      { defaults: { pauseAfter: ['plan'], autoApproveIfRisk: 'low' } },
      { defaults: { pauseAfter: ['plan', 'implement'] } },
    );
    const d = out.defaults as Record<string, unknown>;
    assert.deepEqual(d.pauseAfter, ['plan', 'implement']);
    assert.equal(d.autoApproveIfRisk, 'low');
  });

  it('merges cost.limits without losing per-stage entries', () => {
    const out = deepMergeOverlay(
      { cost: { limits: { perRun: 5, perStage: { plan: 1, implement: 2 } } } },
      { cost: { limits: { perStage: { implement: 3 } } } },
    );
    const cost = out.cost as Record<string, unknown>;
    const limits = cost.limits as Record<string, unknown>;
    assert.equal(limits.perRun, 5);
    const perStage = limits.perStage as Record<string, number>;
    assert.equal(perStage.plan, 1);
    assert.equal(perStage.implement, 3);
  });

  it('preserves unrelated overlay keys', () => {
    const out = deepMergeOverlay({ enabled: true, qa: { enabled: true } }, { defaults: { pauseAfter: ['plan'] } });
    assert.equal(out.enabled, true);
    assert.deepEqual(out.qa, { enabled: true });
    const d = out.defaults as Record<string, unknown>;
    assert.deepEqual(d.pauseAfter, ['plan']);
  });
});
