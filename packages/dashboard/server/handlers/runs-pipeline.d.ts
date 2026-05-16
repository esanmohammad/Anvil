/**
 * Pipeline + spawn-agent routes (Phase 2.6 / migration of remaining
 * closure-dependent cases).
 *
 * These handlers proxy through to closures still owned by
 * `dashboard-server.ts` via `deps.extras.pipelineActions`. Once a future
 * phase moves the closures into a `server/pipeline/*` module, only the
 * boot side rewires — the handler call-shape is unchanged.
 *
 * Migrated:
 *   - run-pipeline
 *   - resume / resume-pipeline (replay button)
 *   - spawn-agent
 *   - stop-run
 *   - run-fix / run-review / run-spike (quick actions)
 */
import { type Handler } from './route.js';
export declare function runsPipelineRoutes(): Record<string, Handler>;
//# sourceMappingURL=runs-pipeline.d.ts.map