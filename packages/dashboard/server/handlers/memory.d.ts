/**
 * Memory WS routes (Wave 3 + Wave 4 + Tier 4 surface).
 *
 * Read-only inspector + the PR-episode plan replay suggestion endpoint.
 * No new write surface — memory writes still go through `recordPrEpisode`
 * (auto-ratified) or the proposal queue (sleeptime ratifies).
 *
 * Routes:
 *   - get-memory-overview        → counts by kind/subtype + recent hits
 *   - search-memory              → hybridSearch results
 *   - get-plan-suggestions       → past PR episodes similar to a feature
 *                                  intent (Wave 3.2 — UI banner consumer
 *                                  will surface these before plan stage)
 *   - get-memory-hit-stats       → hitStatsByKind for the inspector
 *   - get-memory-injections      → injection log for a specific run
 */
import { type Handler } from './route.js';
export declare function memoryRoutes(): Record<string, Handler>;
//# sourceMappingURL=memory.d.ts.map