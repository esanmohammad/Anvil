/**
 * Phase 4a scaffold smoke — verifies that `buildDashboardStepRegistry`
 * returns a usable empty `StepRegistry` and that an empty pipeline runs
 * cleanly through `Pipeline.run()`.
 *
 * Phases 4b–4f progressively populate the registry with real Steps; this
 * test stays valuable as a guardrail that the scaffold remains usable as
 * an empty registry even after Steps are added (callers may pass the same
 * factory with no Steps registered for diagnostic purposes).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus, Pipeline } from '@anvil/core-pipeline';

import { buildDashboardStepRegistry } from '../steps/index.js';

describe('Phase 4a scaffold', () => {
  it('buildDashboardStepRegistry returns an empty registry', () => {
    const registry = buildDashboardStepRegistry({
      project: 'demo',
      workspaceDir: '/tmp/ws',
    });
    assert.equal(registry.steps().length, 0);
  });

  it('an empty dashboard pipeline runs to completion via core-pipeline', async () => {
    const registry = buildDashboardStepRegistry({
      project: 'demo',
      workspaceDir: '/tmp/ws',
      repoNames: ['api', 'web'],
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
    });
    const bus = new InMemoryEventBus();
    const pipeline = new Pipeline({
      registry,
      bus,
      runId: 'phase-4a-smoke',
      workspaceDir: '/tmp/ws',
      repoPaths: { api: '/tmp/api', web: '/tmp/web' },
    });

    const result = await pipeline.run();
    assert.equal(result.status, 'success');
    assert.equal(result.completedSteps.length, 0);
  });
});
