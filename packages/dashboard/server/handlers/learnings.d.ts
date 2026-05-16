/**
 * Learning-loop + checkpoint + regression read routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - get-plan-approval-stats     — learnings stats per project
 *   - list-plan-approval-records  — historical approval/rejection trail
 *   - get-checkpoint-stats        — checkpoint hit-rate snapshot
 *   - get-regression-metrics      — incident → bound-test conversion KPIs
 */
import { type Handler } from './route.js';
export declare function learningsRoutes(): Record<string, Handler>;
//# sourceMappingURL=learnings.d.ts.map