/**
 * Post-run persistence (Phase 3 extraction from `dashboard-server.ts`).
 *
 * `createPostRunPersister(deps)` returns a single async function the
 * pipeline lifecycle calls when a run terminates. The body is unchanged
 * from the legacy `persistRunRecord` closure:
 *
 *   1. Append a comprehensive run record to `<anvilHome>/runs/index.jsonl`.
 *   2. Record in the feature store's per-feature history.
 *   3. Update the feature record (status + cost + PR URLs).
 *   4. `recordPrEpisode` for completed runs that produced a PR.
 *   5. `reflectOnRun` — extract typed lessons via the memory-core
 *      proposal queue, gated by `ANVIL_REFLECTION`.
 *
 * Why a factory: the underlying memoryStore + agentManager + featureStore
 * live inside `startDashboardServer`'s closure. Passing them via a deps
 * object keeps this module a pure-function over its inputs.
 */
import type { PipelineRunState } from '../pipeline-runner.js';
import type { FeatureStore } from '../feature-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
export interface PostRunDeps {
    anvilHome: string;
    runsDir: string;
    runsIndex: string;
    featureStore: FeatureStore;
    memoryStore: MemoryStore;
    agentManager: AgentManager;
    /** Active runs by id — read-only access for the PR-URL aggregation. */
    activeRuns: Map<string, {
        prUrls: Set<string>;
    }>;
    /** Resolve `<workspaceRoot>/<project>` for the reflection invoker cwd. */
    getWorkspaceFromConfig: (project: string) => string | null;
}
export declare function createPostRunPersister(deps: PostRunDeps): (state: PipelineRunState, runId?: string) => Promise<void>;
//# sourceMappingURL=post-run.d.ts.map