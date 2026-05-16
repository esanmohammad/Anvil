/**
 * Settings + provider + memory WS routes (Recipe 7 / Phase 1).
 *
 * Read-only inspector cases for the Settings panel. All migrate cleanly:
 * each is a one-shot read with no mutation that crosses service
 * boundaries. The provider-discovery cache is owned by
 * `provider-registry.ts`; we dynamic-import it on call (matches the
 * legacy case bodies, which used closure-captured imports).
 *
 * Migrated:
 *   - get-providers          — provider discovery → typed snapshot
 *   - get-available-models   — agent-core model list
 *   - get-routing            — flow-stage chain dump (build/fix/review/…)
 *   - get-budget-status      — read budget config + today's spend
 *   - get-conventions        — load convention rules for a project
 *   - get-memory-config      — env-driven reflection toggle
 *   - list-memories          — Memory inspector view
 *   - get-auth-status        — provider key presence (API providers only)
 */
import { type Handler } from './route.js';
export declare function settingsRoutes(): Record<string, Handler>;
//# sourceMappingURL=settings.d.ts.map