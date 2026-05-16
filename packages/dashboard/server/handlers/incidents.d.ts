/**
 * Incident + bind WS routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - ingest-incident        (error wire-type `incident-error`)
 *   - override-bind          (override-by-replayId + Slack notify)
 *   - override-bound-test    (echo `bound-override-applied`,
 *                            error wire-type `bound-override-error`)
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - replay-incident — drives the replay pipeline, depends on
 *     `runReplayPipeline`, `boundTestsStore.appendBound`, Slack notifier.
 */
import { type Handler } from './route.js';
export declare function incidentRoutes(): Record<string, Handler>;
//# sourceMappingURL=incidents.d.ts.map