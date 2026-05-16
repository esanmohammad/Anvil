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
import { runTestGenForProject as runTestGenForProjectCanonical, createTestGenStageStep as createTestGenStageStepCanonical, pickRepoForBehavior, } from '@esankhan3/anvil-core-pipeline';
export { pickRepoForBehavior };
async function loadDashboardTestGenDeps() {
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
        fingerprintConventions: fingerprintConventions,
        extractBehaviorsFromPlan: extractBehaviorsFromPlan,
        groundBehaviors: groundBehaviors,
        emitTestCase: emitTestCase,
        specStore: new TestSpecStore(),
        caseStore: new TestCaseStore(),
    };
}
export async function runTestGenForProject(opts) {
    if (!opts.planSeed)
        return 'Test stage skipped (no plan seed).';
    const deps = await loadDashboardTestGenDeps();
    return runTestGenForProjectCanonical({ ...opts, deps });
}
export function createTestGenStageStep(opts) {
    const id = opts.id ?? 'test-gen-stage';
    return {
        id,
        name: 'Test generation (deterministic)',
        parallelism: 'serial',
        async run(_ctx) {
            if (!opts.planSeed)
                return 'Test stage skipped (no plan seed).';
            const deps = await loadDashboardTestGenDeps();
            const stepFactory = createTestGenStageStepCanonical({ ...opts, deps });
            return stepFactory.run(_ctx);
        },
    };
}
//# sourceMappingURL=test-gen-stage.step.js.map