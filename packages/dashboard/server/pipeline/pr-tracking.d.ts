/**
 * PR tracking (Phase 3 extraction from `dashboard-server.ts`).
 *
 * `createPrTracker(deps)` returns a bundle of:
 *   - `extractPRUrls(text)` — pure regex scan over agent output.
 *   - `fetchPRDetails(url)` — `gh pr view --json …` wrapper that
 *     normalises the result into the `TrackedPR` shape.
 *   - `reviewMapByPrUrl()` — join tracked PRs against the review store.
 *   - `trackedPRsForBroadcast()` — payload shape used by the WS init +
 *     refresh broadcasts.
 *   - `refreshTrackedPRs()` — re-fetch every tracked PR, emit
 *     `prs.updated` if anything changed.
 *   - `trackPR(url)` — fetch + register a new URL, emit if new.
 *   - `loadPRsFromFeatureStore()` — boot-time backfill from SHIP.md +
 *     `feature.json::prUrls`.
 *   - `startPolling(intervalMs)` — kick off the 30s refresh interval,
 *     returns a stop function.
 *
 * The legacy module-scope `trackedPRs` map is encapsulated inside the
 * factory; callers no longer share it via closure.
 */
import type { ReviewStore } from '../review-store.js';
import type { FeatureStore } from '../feature-store.js';
import type { DashboardServices } from '../services/index.js';
export interface TrackedPR {
    id: string;
    title: string;
    repo: string;
    author: string;
    status: 'draft' | 'open' | 'in_review' | 'merged' | 'closed';
    url: string;
    createdAt: number;
    updatedAt: number;
    additions: number;
    deletions: number;
    reviewers: string[];
    labels: string[];
}
export interface PrReviewSummary {
    reviewId: string;
    verdict: 'approve' | 'request-changes' | 'comment';
    blockers: number;
    errors: number;
    warnings: number;
    summary: string;
    reviewedAt: number;
}
export interface TrackedPRWithReview extends TrackedPR {
    review: PrReviewSummary | null;
}
export interface PrTrackerDeps {
    reviewStore: ReviewStore;
    featureStore: FeatureStore;
    services: DashboardServices;
}
export interface PrTracker {
    extractPRUrls: (text: string) => string[];
    fetchPRDetails: (prUrl: string) => Promise<TrackedPR | null>;
    trackedPRsForBroadcast: () => TrackedPRWithReview[];
    refreshTrackedPRs: () => Promise<void>;
    trackPR: (prUrl: string) => Promise<void>;
    loadPRsFromFeatureStore: () => Promise<void>;
    /** Start the 30s background refresh; returns a stop fn (unref-safe). */
    startPolling: (intervalMs?: number) => () => void;
}
export declare function createPrTracker(deps: PrTrackerDeps): PrTracker;
//# sourceMappingURL=pr-tracking.d.ts.map