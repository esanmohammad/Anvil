/**
 * Cost WS routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - respond-cost-breach — echo `cost-breach-response`, error wire-type
 *     `cost-error`. After the response writes, the handler pushes a fresh
 *     cost snapshot via `broadcastCostSnapshot` (closure-side until the
 *     run registry is extracted in Phase 2).
 *
 * NOT migrated (closure-dependent — stay handler-side):
 *   - subscribe-cost, unsubscribe-cost (room model — pure broadcasts)
 *   - list-pending-breaches (cost-breach-handler reads)
 *   - get/update-pipeline-policy (policy file IO + project loader writes)
 */
import { type Handler } from './route.js';
export declare function costRoutes(): Record<string, Handler>;
//# sourceMappingURL=cost.d.ts.map