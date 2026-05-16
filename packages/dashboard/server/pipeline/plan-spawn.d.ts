/**
 * Plan-agent spawn cluster (Phase 3 round-3 extraction from
 * `dashboard-server.ts`).
 *
 * `createPlanSpawn(deps)` returns the bundle:
 *   - `spawnPlanAgent`           — fresh full-plan generation
 *   - `spawnOnePlanVariant`      — one variant of an A/B batch
 *   - `spawnPlanVariants`        — fan out N variants with stagger
 *   - `spawnPlanSectionRegen`    — re-generate a single section
 *   - `retryPlanAgentWithNextModel` — chain-walk to the next model
 *   - `finalizePlanAgent`        — parse + persist + lifecycle
 *   - `planAgentContext`         — Map exposed for the agent-event router
 *
 * Encapsulated state:
 *   - `planAgentContext: Map<agentId, …>` (owned here; the agent-event
 *     router reads/deletes via the exposed reference).
 *
 * All closure deps (agentManager, activeRuns, agentToRunId, services,
 * broadcasts, lifecycle handle, stores, model resolver, workspace
 * getter, KB manager, memory store, outputBuffer reset) come in via
 * the `deps` bag.
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { Plan, PlanSection, PlanStore } from '../plan-store.js';
import type { PlanValidator } from '../plan-validator.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { MemoryStore } from '../memory-store.js';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import type { ActiveRun } from '../broadcasts.js';
import type { PlanLifecycleHandle } from './plan-lifecycle.js';
export interface PlanAgentContextEntry {
    project: string;
    feature: string;
    model: string;
    existingSlug?: string;
    section?: PlanSection;
    variant?: {
        batchId: string;
        index: number;
        label: string;
    };
    variantPrompt?: string;
    burned: Set<string>;
    attemptsRemaining: number;
    sameAgentRetriesRemaining: number;
}
export interface PlanSpawnDeps {
    agentManager: AgentManager;
    planStore: PlanStore;
    planValidator: PlanValidator;
    kbManager: KnowledgeBaseManager;
    memoryStore: MemoryStore;
    projectLoader: ProjectLoader;
    services: DashboardServices;
    activeRuns: Map<string, ActiveRun>;
    agentToRunId: Map<string, string>;
    broadcastActiveRuns: () => void;
    getWorkspaceFromConfig: (project: string) => string | null;
    resetOutputBuffer: () => void;
    /** Stage-policy resolver for `plan` and its sub-stages. */
    resolvePlanStageModel: (userPick?: string) => string;
    /** Plan lifecycle handle — drives the finalize-time state machine. */
    lifecycle: Pick<PlanLifecycleHandle, 'dispatchLifecycle' | 'isPartOfActiveRefine' | 'noteRefineRegenCompleted'>;
}
export interface PlanSpawnHandle {
    spawnPlanAgent: (project: string, feature: string, modelId?: string, retryState?: {
        burned: Set<string>;
        attemptsRemaining: number;
    }) => void;
    spawnOnePlanVariant: (project: string, feature: string, variant: {
        label: string;
        prompt?: string;
    }, batchId: string, index: number, model: string, retryState?: {
        burned: Set<string>;
        attemptsRemaining: number;
    }) => void;
    spawnPlanVariants: (project: string, feature: string, variants: Array<{
        label: string;
        prompt?: string;
    }>, modelId?: string) => void;
    spawnPlanSectionRegen: (existingPlan: Plan, section: PlanSection, modelId?: string, retryState?: {
        burned: Set<string>;
        attemptsRemaining: number;
    }, fixPrompt?: string) => void;
    retryPlanAgentWithNextModel: (ctx: PlanAgentContextEntry, reason: string) => Promise<boolean>;
    finalizePlanAgent: (agentId: string, agentOutput: string) => void;
    planAgentContext: Map<string, PlanAgentContextEntry>;
}
export declare function createPlanSpawn(deps: PlanSpawnDeps): PlanSpawnHandle;
//# sourceMappingURL=plan-spawn.d.ts.map