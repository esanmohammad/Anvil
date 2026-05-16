/**
 * Phase H11 — `test-gen-stage.step` was promoted into core-pipeline
 * with all heavy deps (convention fingerprinting, behavior extraction,
 * grounding, code emission, spec/case stores) injected as a `TestGenDeps`
 * bundle. This file adapts the dashboard's FS-backed implementations
 * into that bundle and exposes the same legacy API surface.
 *
 * @deprecated Direct consumers should construct their own `TestGenDeps`
 *   and call canonical `runTestGenForProject` / `createTestGenStageStep`
 *   from `@esankhan3/anvil-core-pipeline`.
 */

import type { Plan } from '@esankhan3/anvil-core-pipeline';
import {
  runTestGenForProject as runTestGenForProjectCanonical,
  createTestGenStageStep as createTestGenStageStepCanonical,
  pickRepoForBehavior,
  type TestGenDeps,
  type TestGenArtifactEvent,
  type Step,
  type StepContext,
} from '@esankhan3/anvil-core-pipeline';

export type { TestGenArtifactEvent };
export { pickRepoForBehavior };

export interface RunTestGenForProjectOptions {
  planSeed?: { project: string; slug: string; version: number; plan: Plan } | null;
  project: string;
  model: string;
  workspaceDir: string;
  repoLocalPaths: Record<string, string>;
  onConventionsDetected?: (runnerLabel: string) => void;
  onArtifactWritten?: (event: TestGenArtifactEvent) => void;
}

async function loadDashboardTestGenDeps(): Promise<TestGenDeps> {
  const { fingerprintConventions } = await import('../convention-fingerprinter.js');
  const { extractBehaviorsFromPlan } = await import('../behavior-extractor.js');
  const { groundBehaviors } = await import('../test-grounder.js');
  const { emitTestCase } = await import('../test-code-emitter.js');
  const { TestSpecStore } = await import('../test-spec-store.js');
  const { TestCaseStore } = await import('../test-case-store.js');
  // Dashboard's full Behavior / TestCase shapes are supersets of the
  // structural TestGenBehavior / TestGenCase the canonical step reads —
  // route through `unknown` to bypass the supertype check.
  return {
    fingerprintConventions: fingerprintConventions as unknown as TestGenDeps['fingerprintConventions'],
    extractBehaviorsFromPlan: extractBehaviorsFromPlan as unknown as TestGenDeps['extractBehaviorsFromPlan'],
    groundBehaviors: groundBehaviors as unknown as TestGenDeps['groundBehaviors'],
    emitTestCase: emitTestCase as unknown as TestGenDeps['emitTestCase'],
    specStore: new TestSpecStore() as unknown as TestGenDeps['specStore'],
    caseStore: new TestCaseStore() as unknown as TestGenDeps['caseStore'],
  };
}

export async function runTestGenForProject(
  opts: RunTestGenForProjectOptions,
): Promise<string> {
  if (!opts.planSeed) return 'Test stage skipped (no plan seed).';
  const deps = await loadDashboardTestGenDeps();
  return runTestGenForProjectCanonical({ ...opts, deps });
}

export interface TestGenStageStepOptions extends RunTestGenForProjectOptions {
  id?: string;
}

export function createTestGenStageStep(
  opts: TestGenStageStepOptions,
): Step<unknown, string> {
  const id = opts.id ?? 'test-gen-stage';
  return {
    id,
    name: 'Test generation (deterministic)',
    parallelism: 'serial',
    async run(_ctx: StepContext<unknown>): Promise<string> {
      if (!opts.planSeed) return 'Test stage skipped (no plan seed).';
      const deps = await loadDashboardTestGenDeps();
      const stepFactory = createTestGenStageStepCanonical({ ...opts, deps });
      return stepFactory.run(_ctx);
    },
  };
}
