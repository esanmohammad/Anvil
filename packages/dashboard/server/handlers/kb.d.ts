/**
 * Knowledge-base WS route (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - refresh-knowledge-base — echo `kb-refresh-started`; legacy `error`
 *     wire-type when a refresh is already in progress.
 *
 * NOT migrated (read-only — stay handler-side until a read-route shape
 * lands):
 *   - get-kb-data, query-kb, get-kb-index, get-kb-status.
 */
import { type Handler } from './route.js';
export declare function kbRoutes(): Record<string, Handler>;
//# sourceMappingURL=kb.d.ts.map