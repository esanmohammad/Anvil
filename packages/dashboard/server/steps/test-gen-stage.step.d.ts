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
import { pickRepoForBehavior, type TestGenArtifactEvent, type Step } from '@esankhan3/anvil-core-pipeline';
export type { TestGenArtifactEvent };
export { pickRepoForBehavior };
export interface RunTestGenForProjectOptions {
    planSeed?: {
        project: string;
        slug: string;
        version: number;
        plan: Plan;
    } | null;
    project: string;
    model: string;
    workspaceDir: string;
    repoLocalPaths: Record<string, string>;
    onConventionsDetected?: (runnerLabel: string) => void;
    onArtifactWritten?: (event: TestGenArtifactEvent) => void;
}
export declare function runTestGenForProject(opts: RunTestGenForProjectOptions): Promise<string>;
export interface TestGenStageStepOptions extends RunTestGenForProjectOptions {
    id?: string;
}
export declare function createTestGenStageStep(opts: TestGenStageStepOptions): Step<unknown, string>;
//# sourceMappingURL=test-gen-stage.step.d.ts.map