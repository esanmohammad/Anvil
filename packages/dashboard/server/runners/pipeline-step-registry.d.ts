/**
 * Phase B — `buildPipelineStepRegistry` was promoted into core-pipeline
 * as `buildStandardStepRegistry`. This file is a back-compat re-export
 * so any in-flight branch / external consumer still resolves.
 *
 * @deprecated Import directly from `@esankhan3/anvil-core-pipeline`:
 *   import { buildStandardStepRegistry } from '@esankhan3/anvil-core-pipeline';
 *
 * This shim will be deleted in Phase D once the dashboard fully drives
 * its run via `Pipeline.run()` over the standard registry.
 */
import { type StepRegistry, type StandardRegistryDeps } from '@esankhan3/anvil-core-pipeline';
/** @deprecated Use `StandardRegistryDeps` from `@esankhan3/anvil-core-pipeline`. */
export type PipelineStageStepDeps = Pick<StandardRegistryDeps, 'runStage'>;
/** @deprecated Use `buildStandardStepRegistry` from `@esankhan3/anvil-core-pipeline`. */
export declare function buildPipelineStepRegistry(deps: PipelineStageStepDeps): StepRegistry;
//# sourceMappingURL=pipeline-step-registry.d.ts.map