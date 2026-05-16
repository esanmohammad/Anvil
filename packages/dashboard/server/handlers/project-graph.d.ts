/**
 * Project-graph WS routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - build-project-graph — fire-and-forget kickoff. Progress + terminal
 *     status stream through `services.projectGraph.emit(...)`.
 *
 * NOT migrated (reads — stay handler-side):
 *   - get-project-graph-status (knowledge-core readback)
 *   - get-graph-nodes (graph readback)
 */
import { type Handler } from './route.js';
export declare function projectGraphRoutes(): Record<string, Handler>;
//# sourceMappingURL=project-graph.d.ts.map