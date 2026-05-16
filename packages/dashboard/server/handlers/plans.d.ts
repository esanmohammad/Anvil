/**
 * Plan-domain WS routes (Recipe 7 / Phase 1).
 *
 * One `route(...)` per `case '<plan-action>':` body that has a matching
 * `services.plans.<method>(...)` in `services/index.ts`. The case bodies
 * in `dashboard-server.ts` are deleted in the same change that switches
 * `handleClientMessage` over to the registry; this file becomes the new
 * home for each handler.
 *
 * Migrated:
 *   - add-plan-comment       (fire-and-forget — emit-only via service)
 *   - resolve-plan-comment   (fire-and-forget — emit-only via service)
 *   - delete-plan-comment    (fire-and-forget — emit-only via service)
 *   - approve-plan           (service write + handler-side lifecycle tick)
 *   - adopt-plan-variant     (echo `plan-variant-adopted`)
 *   - validate-plan          (echo `plan-validation`; handler reads
 *                             projectLoader for budget caps + repo map)
 *   - estimate-plan          (echo `plan-estimate`)
 *   - save-plan              (echo `plan-updated` + two lifecycle ticks)
 *   - share-plan             (echo `plan-shared`)
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - regen-plan-section, auto-refine, execute-plan, run-plan-variants —
 *     these spawn agent processes through `spawnPlanAgent` /
 *     `spawnPlanSectionRegen` / `spawnPlanVariants`, which live inside
 *     `startDashboardServer`. Each lands as a service method once that
 *     closure is extracted to its own module.
 *
 * Read-only plan actions (`list-plan-comments`, `list-plan-approvals`,
 * `get-plans`, `get-plan`, etc.) also stay in the monolith for now —
 * they read `planStore` directly and don't need a service method. Phase 1
 * migrates them once a read-only `route()` shape is comfortable to write.
 */
import { type Handler } from './route.js';
/**
 * Build the plan-domain route map. Returns a `Record<action, Handler>`
 * that the registry spreads into the top-level handlerRegistry.
 *
 * Today the function is a no-op factory — it takes no args because every
 * dep these handlers need is on `deps` at call time. Keeping the factory
 * form anyway so Phase 2's lifecycle-extraction can pass closures in
 * (e.g. `attachX({ dispatchLifecycle, projectLoader })`) without a wire
 * refactor.
 */
export declare function planRoutes(): Record<string, Handler>;
//# sourceMappingURL=plans.d.ts.map