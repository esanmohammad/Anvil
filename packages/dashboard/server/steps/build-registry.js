/**
 * `buildDashboardStepRegistry` — assembles the dashboard's `StepRegistry`
 * for a single pipeline run.
 *
 * Phase 4a lands the scaffold only — the registry is empty. Phases 4b–4f
 * register actual Step implementations through the same factory, so the
 * eventual Phase 4f cutover (pipeline-runner.ts → thin façade) is just a
 * matter of swapping `PipelineRunner.run()` for `new Pipeline(...).run()`.
 *
 * The dependency shape captures what each future Step will need from the
 * dashboard side:
 *   - `featureStore` / `manifestStore` — for 4b (FEATURE-MANIFEST.json)
 *   - `planRiskScorer` deps        — for 4c (PLAN-RISK.json)
 *   - `taskBundler` deps           — for 4d (TASK-BUNDLES.json)
 *   - `clarifyInputResolver`       — for 4e (interactive WS clarify)
 *
 * Steps consume these via closure capture inside the factory so the resulting
 * `Step.run()` doesn't need to type-thread dashboard internals through
 * `StepContext` (which stays generic per core-pipeline's contract).
 */
import { InMemoryStepRegistry } from '@anvil/core-pipeline';
import { FEATURE_MANIFEST_STAGES, createFeatureManifestStep, } from './feature-manifest.step.js';
/**
 * Build the dashboard's `StepRegistry` for one pipeline run.
 *
 * What lands today (Phase 4a–4b):
 *   - empty registry by default
 *   - per-stage feature-manifest extraction Steps when both
 *     `featureSlug` + `manifestStore` are supplied; one Step per
 *     stage in `FEATURE_MANIFEST_STAGES`, each id-prefixed with
 *     `feature-manifest:`. Caller can later `insertAfter(stageId, …)`
 *     to splice persona Steps in front of each extractor.
 *
 * Phases 4c–4f extend this factory with plan-risk, task-bundler,
 * clarify, and the final orchestrator façade.
 */
export function buildDashboardStepRegistry(deps) {
    const registry = new InMemoryStepRegistry();
    if (deps.featureSlug && deps.manifestStore) {
        for (const stageName of FEATURE_MANIFEST_STAGES) {
            const step = createFeatureManifestStep({
                stageName,
                project: deps.project,
                featureSlug: deps.featureSlug,
                manifestStore: deps.manifestStore,
            });
            registry.register(step);
        }
    }
    return registry;
}
//# sourceMappingURL=build-registry.js.map