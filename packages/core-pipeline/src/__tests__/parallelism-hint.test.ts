/**
 * Phase 5 sanity test — Step.parallelism hint round-trips through the
 * StepRegistry and is observable via `steps()`. The Pipeline walker
 * itself doesn't fan steps out across projects yet (Phase 7 deals with
 * sub-step recursion); this test exists so a regression that drops the
 * hint is caught before Phase 7 wires it up.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStepRegistry, type Step } from '../index.js';

describe('Step.parallelism (Phase 5)', () => {
  it("preserves 'per-project' hint through the registry", () => {
    const r = new InMemoryStepRegistry();
    const perProject: Step<unknown, unknown> = {
      id: 'specs',
      parallelism: 'per-project',
      run: async () => undefined,
    };
    const serial: Step<unknown, unknown> = {
      id: 'build',
      parallelism: 'serial',
      run: async () => undefined,
    };
    const noHint: Step<unknown, unknown> = { id: 'requirements', run: async () => undefined };
    r.register(perProject);
    r.register(serial);
    r.register(noHint);
    const list = r.steps();
    assert.equal(list[0].parallelism, 'per-project');
    assert.equal(list[1].parallelism, 'serial');
    assert.equal(list[2].parallelism, undefined);
  });
});
