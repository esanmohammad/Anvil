/**
 * Contract-guard read routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - list-contracts    — discover OpenAPI/gRPC contracts per repo
 *   - rescan-contracts  — same plus consumer-call detection + graph build
 *
 * Both close over `projectLoader.getRepoLocalPaths` for the repo set;
 * everything else is dynamic-imported on call (matches the legacy case
 * bodies, which used module-level imports).
 */
import { type Handler } from './route.js';
export declare function contractsRoutes(): Record<string, Handler>;
//# sourceMappingURL=contracts.d.ts.map