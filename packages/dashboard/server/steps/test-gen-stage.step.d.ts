/**
 * `test-gen-stage` — Phase 4f.5 of the dashboard consolidation.
 *
 * Lifts `pipeline-runner.ts:runTestGenStage()` — the deterministic
 * test-spec generator that runs after Build and before Validate. It does
 * NOT spawn an LLM agent: it fingerprints conventions, extracts behaviors
 * from the seed Plan, grounds them against the repos on disk, emits
 * test-case scaffolds, and persists `TestSpec` + `TestCase` records.
 *
 * Heavy deps (`convention-fingerprinter`, `behavior-extractor`,
 * `test-grounder`, `test-code-emitter`, `TestSpecStore`, `TestCaseStore`)
 * are dynamically imported inside the helper — same lazy-loading the
 * legacy uses to keep dashboard cold-start fast for runs that don't hit
 * the test stage.
 */
import type { Plan } from '../plan-store.js';
import type { Step } from '@anvil/core-pipeline';
export interface TestGenArtifactEvent {
    stage: string;
    file: string;
    summary: string;
    content: string;
}
export interface RunTestGenForProjectOptions {
    /**
     * Plan from which behaviors are extracted. When undefined, the helper
     * returns the legacy "Test stage skipped (no plan seed)." message.
     */
    planSeed?: {
        project: string;
        slug: string;
        version: number;
        plan: Plan;
    } | null;
    /** Project slug — forwarded to TestSpec / TestCase metadata. */
    project: string;
    /** Default model id captured into the TestSpec when the plan doesn't carry one. */
    model: string;
    /** Workspace root — used as the convention-fingerprint fallback when no repo exists yet. */
    workspaceDir: string;
    /** Map of repoName → absolute path. */
    repoLocalPaths: Record<string, string>;
    /**
     * Called after the helper has decided which conventions runner the
     * stage detected. Used by the legacy to seed
     * `state.stages[stageIndex].artifact = "Detected runner: <runner>\n"`.
     */
    onConventionsDetected?: (runnerLabel: string) => void;
    /**
     * Called once with the final summary so the dashboard can broadcast
     * `'artifact-written'` (legacy WS event). The helper does not emit
     * directly — the caller owns the event bus surface.
     */
    onArtifactWritten?: (event: TestGenArtifactEvent) => void;
}
interface BehaviorTargetLike {
    target: {
        file: string;
    };
}
/**
 * Pick the repo whose local path contains the behavior's target file.
 * Lifted verbatim from `pipeline-runner.ts:pickRepoForBehavior()`.
 */
export declare function pickRepoForBehavior(behavior: BehaviorTargetLike, repoLocalPaths: Record<string, string>): string | null;
/**
 * Run the deterministic test-generation stage. Returns the human-readable
 * summary string used as the stage artifact + the `'artifact-written'`
 * event payload.
 *
 * Mirrors `pipeline-runner.ts:runTestGenStage()` step-by-step:
 *   1. Fingerprint conventions on the first repo with code (or workspace).
 *   2. Extract behaviors from the plan (max 20 per repo).
 *   3. Ground behaviors against disk in all repos.
 *   4. Persist a `TestSpec` (v1 lineage).
 *   5. Emit one `TestCase` per behavior; persist via `TestCaseStore`.
 *   6. Write each test file into its target repo (skips non-anvil-generated).
 *   7. Build + return the summary string.
 */
export declare function runTestGenForProject(opts: RunTestGenForProjectOptions): Promise<string>;
export interface TestGenStageStepOptions extends RunTestGenForProjectOptions {
    /** Optional Step id override; defaults to `test-gen-stage`. */
    id?: string;
}
/**
 * Step factory for the test-generation stage. NOT auto-registered —
 * Phase 4f.7 wires registration once `Pipeline.run()` becomes the
 * orchestrator. Output: the summary string.
 */
export declare function createTestGenStageStep(opts: TestGenStageStepOptions): Step<unknown, string>;
export {};
//# sourceMappingURL=test-gen-stage.step.d.ts.map