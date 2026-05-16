/**
 * Top-level handler registry (Recipe 7 / Phase 1).
 *
 * `dashboard-server.ts` `handleClientMessage` consults this map first.
 * If `msg.action` matches a registered route, the route handles parse +
 * dispatch + reply and the switch is skipped entirely. Unmatched actions
 * fall through to the legacy switch so we can migrate one domain at a
 * time without breaking the rest.
 *
 * As more domain files land (`runs.ts`, `tests.ts`, etc.), each spreads
 * its route map into this aggregate via `...domainRoutes()`.
 *
 * Acceptance per the plan: `grep -c "case '"` in `dashboard-server.ts`
 * drops to 0 once every action is in this registry.
 */
import type { Handler } from './route.js';
/** Construct the registry. Pure factory — no side effects. */
export declare function buildRegistry(): Record<string, Handler>;
/**
 * Default singleton — boot-time cost is one object spread. Importing
 * this is cheaper than calling `buildRegistry()` at every dispatch.
 */
export declare const handlerRegistry: Record<string, Handler>;
//# sourceMappingURL=registry.d.ts.map