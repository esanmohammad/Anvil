/**
 * Incident replay route (Phase 2.6 migration).
 *
 * Migrated:
 *   - replay-incident
 *
 * Calls `runReplayPipeline` dynamically (same as legacy), reading from
 * `unsafeStores.*` and using the bundled agent-manager handle. The
 * post-result Slack nudge stays inline since it is fire-and-forget.
 */
import { type Handler } from './route.js';
export declare function incidentsSpawnRoutes(): Record<string, Handler>;
//# sourceMappingURL=incidents-spawn.d.ts.map