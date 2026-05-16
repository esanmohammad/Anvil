/**
 * CI-triage read route (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - list-ci-triage — history records for a project (paged by `limit`)
 *
 * NOT migrated (mutating — closure-dependent on the agent manager +
 * analyzer pipeline):
 *   - analyze-ci-log
 */
import { type Handler } from './route.js';
export declare function ciTriageRoutes(): Record<string, Handler>;
//# sourceMappingURL=ci-triage.d.ts.map