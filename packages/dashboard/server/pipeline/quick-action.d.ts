/**
 * Quick-action spawner (Phase 3 round-3 extraction from
 * `dashboard-server.ts`).
 *
 * `createQuickActionSpawner(deps)` returns the `spawnQuickAction`
 * closure used by `run-fix` / `run-review` / `run-spike`. The body is
 * verbatim from the legacy closure; closure-resident state
 * (`activeRuns`, `agentToRunId`, `outputBuffer`) is passed through
 * `deps` so the dashboard-server keeps owning the canonical refs.
 *
 * `outputBuffer` is interesting: spawnQuickAction does
 * `outputBuffer = []` (reassignment, not mutation). Reassigning the
 * outer `let` variable invalidates references held by
 * `attachAgentEventRouter`. The legacy behavior is preserved — call
 * `deps.resetOutputBuffer()` from inside the factory to keep
 * dashboard-server's local binding in control.
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { MemoryStore } from '../memory-store.js';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import type { ActiveRun, ActivityEntry } from '../broadcasts.js';
export interface QuickActionDeps {
    agentManager: AgentManager;
    kbManager: KnowledgeBaseManager;
    memoryStore: MemoryStore;
    projectLoader: ProjectLoader;
    services: DashboardServices;
    activeRuns: Map<string, ActiveRun>;
    agentToRunId: Map<string, string>;
    broadcastActiveRuns: () => void;
    getWorkspaceFromConfig: (project: string) => string | null;
    /** Clear the dashboard's outputBuffer (let-rebinding lives in dashboard-server). */
    resetOutputBuffer: () => void;
    /** Append a single entry to the dashboard's outputBuffer. */
    pushOutputEntry: (entry: ActivityEntry) => void;
}
export type QuickActionType = 'run-fix' | 'run-review' | 'run-spike';
export declare function createQuickActionSpawner(deps: QuickActionDeps): (actionType: QuickActionType, project: string, description: string, model?: string) => void;
//# sourceMappingURL=quick-action.d.ts.map