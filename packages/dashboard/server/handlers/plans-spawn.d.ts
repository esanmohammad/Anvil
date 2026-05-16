/**
 * Plan-pipeline + plan-section routes (Phase 2.6 migration).
 *
 * Migrated:
 *   - run-plan
 *   - run-plan-variants
 *   - regen-plan-section
 *   - auto-refine-plan
 *   - execute-plan
 *
 * Each handler thin-wraps a closure (`spawnPlanAgent`,
 * `spawnPlanSectionRegen`, `dispatchLifecycle`, `executeLifecycleRefine`,
 * `startPipeline`) that's still owned by `dashboard-server.ts`.
 */
import { type Handler } from './route.js';
export declare function plansSpawnRoutes(): Record<string, Handler>;
//# sourceMappingURL=plans-spawn.d.ts.map