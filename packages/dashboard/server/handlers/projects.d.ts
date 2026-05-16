/**
 * Project-overview WS routes (Recipe 7 / Phase 1).
 *
 * Migrated (read-only, no closure deps beyond what extras already
 * holds):
 *   - get-interrupted-pipelines — `findInterruptedPipelines` dynamic-imported
 *   - get-branches               — git fetch + branch listing in the
 *                                  workspace dir; closure-resident
 *                                  `getWorkspaceFromConfig` lookup
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - get-state, get-projects   (`sendInit` closure)
 *   - get-features              (`featureStore.listFeatures` lookup)
 *   - get-runs, get-active-runs (`loadRunsSync`, `broadcastActiveRuns` closures)
 *   - get-run                   (reads `activeRuns` map + `featureStore`)
 *   - get-overview              (`buildProjectOverview` closure)
 *   - refresh-prs               (`refreshTrackedPRs` / `trackedPRsForBroadcast` closures)
 */
import { type Handler } from './route.js';
export declare function projectRoutes(): Record<string, Handler>;
//# sourceMappingURL=projects.d.ts.map