/**
 * Plan-lifecycle walker (Phase 3 extraction from `dashboard-server.ts`).
 *
 * Owns:
 *   - `planLifecycle: Map<key, LifecycleContext>` — per-(project,slug)
 *     state machine context held across dispatches.
 *   - `outstandingRefineRegens: Map<key, …>` — tracks async regen
 *     fan-outs scheduled by `runAutoRefinePass` so a single user click
 *     can never stack passes.
 *
 * Exposes:
 *   - `dispatchLifecycle(project, slug, event)` — wraps
 *     `transitionLifecycle(...)` and emits `plan-lifecycle` after.
 *   - `executeLifecycleVerify(project, slug)` — sync verify pass.
 *   - `executeLifecycleRefine(project, slug)` — single bounded refine
 *     pass; async regens fire-and-forget; `noteRefineRegenCompleted`
 *     drains the outstanding count and resolves the lifecycle.
 *   - `runAutoRefinePass(project, slug)` — deterministic patches +
 *     targeted regen dispatch.
 *   - `isPartOfActiveRefine(project, slug)` — gate against re-entry.
 *   - `noteRefineRegenCompleted(project, slug)` — call from
 *     `finalizePlanAgent` when a section-regen agent finishes.
 *   - `getSnapshot(project, slug)` — async lifecycle snapshot for the
 *     `getPlanLifecycleSnapshot` extras slot.
 *
 * The factory takes a forward-ref `getSpawnPlanSectionRegen()` getter
 * so the lifecycle module can call back into the (still-monolithic)
 * plan-spawn closures without a circular import.
 */
import type { Plan, PlanSection } from '../plan-store.js';
import type { PlanStore } from '../plan-store.js';
import type { PlanValidator } from '../plan-validator.js';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import type { LifecycleEvent, LifecycleSnapshot } from '@esankhan3/anvil-core-pipeline';
export interface PlanLifecycleDeps {
    planStore: PlanStore;
    planValidator: PlanValidator;
    projectLoader: ProjectLoader;
    services: DashboardServices;
    broadcastPlanLifecycle: (snap: LifecycleSnapshot) => void;
    /**
     * Forward-ref to the section-regen spawner. Still owned by
     * `dashboard-server.ts`; the lifecycle module never imports it
     * directly to avoid a cycle.
     */
    getSpawnPlanSectionRegen: () => (existingPlan: Plan, section: PlanSection, modelId?: string, retryState?: {
        burned: Set<string>;
        attemptsRemaining: number;
    }, fixPrompt?: string) => void;
}
export interface PlanLifecycleHandle {
    dispatchLifecycle: (project: string, slug: string, event: LifecycleEvent) => Promise<LifecycleSnapshot>;
    executeLifecycleVerify: (project: string, slug: string) => Promise<void>;
    executeLifecycleRefine: (project: string, slug: string) => Promise<void>;
    runAutoRefinePass: (project: string, slug: string) => Promise<number | null>;
    isPartOfActiveRefine: (project: string, slug: string) => boolean;
    noteRefineRegenCompleted: (project: string, slug: string) => void;
    /** Snapshot for the `get-plan-lifecycle` registry handler. */
    getSnapshot: (project: string, slug: string) => Promise<LifecycleSnapshot | null>;
}
export declare function createPlanLifecycle(deps: PlanLifecycleDeps): PlanLifecycleHandle;
//# sourceMappingURL=plan-lifecycle.d.ts.map