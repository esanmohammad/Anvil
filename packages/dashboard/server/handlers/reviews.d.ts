/**
 * Review-domain WS routes (Recipe 7 / Phase 1).
 *
 * Migrated (service methods already exist):
 *   - resolve-review-finding   (fire-and-forget; emit-only)
 *   - apply-review-patch       (echo `review-patch-applied`, error
 *                              wire-type `review-patch-error`; preserves
 *                              the legacy `{ findingId, message }` shape)
 *   - publish-review           (echo `review-published`; setImmediate
 *                              barrier so dismissed findings settle first)
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - run-pr-review, run-incremental-review, apply-review-fix —
 *     all spawn pipelines / call `applyReviewFix` closure inside
 *     `startDashboardServer`.
 */
import { type Handler } from './route.js';
export declare function reviewRoutes(): Record<string, Handler>;
//# sourceMappingURL=reviews.d.ts.map