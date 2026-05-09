/**
 * `task-bundler.step` — wraps `parseTasks()` + `groupTasksForExecution()`
 * from `engineer-task-bundler.ts` into a `Step<string, TaskBundleOutput>`.
 *
 * Phase 4d of the dashboard consolidation. Lifts the parsing + execution-
 * grouping work that today happens inline in
 * `pipeline-runner.ts:runBuildForRepo()` (and again in the test-gen path)
 * so Phase 4f's per-repo build Step can read a pre-parsed bundle from
 * `ctx.artifacts` instead of re-parsing TASKS.md every call.
 *
 * Step semantics:
 *   - input:  the repo's TASKS.md content as a string
 *   - output: `{ tasks: ParsedTask[], groups: ExecutionGroup[] }` —
 *             downstream Steps (e.g. the per-task build fanout) consume
 *             this directly. Empty input → empty bundle (no throw).
 *   - emits:  `TASK-BUNDLES.json` artifact with the same payload, so bus
 *             subscribers (audit, dashboard-state) see the bundle land
 *             and so the artifact is recoverable post-run.
 *
 * `bundleFiles()` from the same module is NOT lifted here — it reads from
 * disk per task and is consumed only inside the build fanout. Phase 4e
 * (or 4f, depending on how the build Step shakes out) will lift it.
 *
 * Per-repo composition (Phase 4f): the build Step will be declared
 * `parallelism: 'per-repo'` so the walker fans it across `ctx.repoPaths`.
 * Today's TaskBundlerStep is `serial`; Phase 4f either wraps it with
 * per-repo fanout or composes it inside a per-repo build Step.
 */
import type { Step } from '@esankhan3/anvil-core-pipeline';
import { type ExecutionGroup, type ParsedTask } from '@esankhan3/anvil-core-pipeline';
export declare const TASK_BUNDLES_ARTIFACT_ID = "TASK-BUNDLES.json";
export interface TaskBundleOutput {
    /** Parsed tasks in input order. */
    tasks: ParsedTask[];
    /** Execution groups (parallelism + dependency batches). */
    groups: ExecutionGroup[];
}
export interface TaskBundlerStepOptions {
    /** Step id; defaults to `task-bundler`. */
    id?: string;
    /**
     * Optional per-repo identifier — when provided, the emitted artifact id
     * is `TASK-BUNDLES.json:${repoName}` so several per-repo Steps can
     * coexist in one run without overwriting each other.
     */
    repoName?: string;
    /**
     * Optional callback fired with the bundle. Useful for tests + for the
     * legacy runner during the cutover so `runBuildForRepo` can read the
     * bundle without re-parsing TASKS.md.
     */
    onBundle?: (bundle: TaskBundleOutput) => void;
}
/**
 * Build a TASK-BUNDLES Step. Phase 4f registers one of these per repo
 * after each repo's tasks-stage artifact lands.
 */
export declare function createTaskBundlerStep(opts?: TaskBundlerStepOptions): Step<string, TaskBundleOutput>;
//# sourceMappingURL=task-bundler.step.d.ts.map