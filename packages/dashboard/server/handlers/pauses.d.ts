/**
 * Pipeline-pause read routes (Recipe 7 / Phase 1).
 *
 * The pause module already exports its own envelope-shaped helpers
 * (`handleListPauses`, `handleGetPause`) — they return a full
 * `{type, payload}` object instead of just a payload. We call them
 * inside the `handle` callback and send directly on `ws` because the
 * shape doesn't fit the `wireType` echo path.
 *
 * Migrated:
 *   - list-pipeline-pauses
 *   - get-pipeline-pause
 *
 * NOT migrated (write — closure-dependent on `auditLog`,
 * `learningsStore`, the run-registry):
 *   - resume-pipeline-pause / cancel-pipeline-pause.
 */
import { type Handler } from './route.js';
export declare function pauseRoutes(): Record<string, Handler>;
//# sourceMappingURL=pauses.d.ts.map