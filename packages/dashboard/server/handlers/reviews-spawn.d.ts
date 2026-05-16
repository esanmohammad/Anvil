/**
 * Review-spawn routes (Phase 2.6 migration).
 *
 * Migrated:
 *   - run-review-pr
 *   - run-review-incremental
 *   - apply-review-fix
 *
 * Thin wrappers over `pipelineActions.startReviewRun` / `applyReviewFix`.
 */
import { type Handler } from './route.js';
export declare function reviewsSpawnRoutes(): Record<string, Handler>;
//# sourceMappingURL=reviews-spawn.d.ts.map