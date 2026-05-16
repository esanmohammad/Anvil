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

import { execSync } from 'node:child_process';
import type { ReviewStore } from '../review-store.js';
import type { FeatureStore } from '../feature-store.js';
import type { DashboardServices } from '../services/index.js';
import { PR_URL_REGEX } from '@esankhan3/anvil-core-pipeline';

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

export function createPrTracker(deps: PrTrackerDeps): PrTracker {
  const trackedPRs = new Map<string, TrackedPR>();

  function extractPRUrls(text: string): string[] {
    PR_URL_REGEX.lastIndex = 0;
    const matches = text.match(PR_URL_REGEX);
    return matches ? [...new Set(matches)] : [];
  }

  async function fetchPRDetails(prUrl: string): Promise<TrackedPR | null> {
    try {
      const result = execSync(
        `gh pr view "${prUrl}" --json number,title,headRepository,author,state,url,createdAt,updatedAt,additions,deletions,reviewRequests,labels,isDraft,reviewDecision`,
        { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString();

      const data = JSON.parse(result);

      let status: TrackedPR['status'] = 'open';
      if (data.isDraft) status = 'draft';
      else if (data.state === 'MERGED') status = 'merged';
      else if (data.state === 'CLOSED') status = 'closed';
      // `in_review` = waiting on a reviewer. APPROVED PRs stay 'open' —
      // the board shouldn't park them in a column that implies more
      // reviewer work is needed.
      else if (data.reviewDecision === 'CHANGES_REQUESTED'
               || (data.reviewRequests && data.reviewRequests.length > 0)) status = 'in_review';

      const repoName = data.headRepository?.name
        ?? prUrl.match(/github\.com\/[^/]+\/([^/]+)/)?.[1]
        ?? 'unknown';

      return {
        id: prUrl,
        title: data.title ?? `PR #${data.number}`,
        repo: repoName,
        author: data.author?.login ?? 'anvil',
        status,
        url: data.url ?? prUrl,
        createdAt: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
        updatedAt: data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now(),
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        reviewers: (data.reviewRequests ?? [])
          .map((r: { login?: string; name?: string }) => r.login ?? r.name ?? '')
          .filter(Boolean),
        labels: (data.labels ?? [])
          .map((l: { name?: string }) => l.name ?? '')
          .filter(Boolean),
      };
    } catch {
      // `gh pr view` failures (auth, network, ETIMEDOUT on cancellation
      // cleanup) shouldn't spam the terminal — silently ignore. The PR
      // still surfaces via the activity-log scanner if it ever appears
      // in agent output.
      return null;
    }
  }

  function reviewMapByPrUrl(): Map<string, PrReviewSummary> {
    const m = new Map<string, PrReviewSummary>();
    try {
      const all = deps.reviewStore.listReviews(undefined, 500);
      for (const r of all) {
        if (m.has(r.prUrl)) continue;
        const sev = r.severityCounts;
        const blockers = sev.blocker ?? 0;
        const errors = sev.error ?? 0;
        const warnings = sev.warn ?? 0;
        const issueCount = blockers + errors;
        const summary = r.verdict === 'approve'
          ? 'Approved — no blocking issues'
          : r.verdict === 'request-changes'
            ? `${issueCount} issue${issueCount === 1 ? '' : 's'}${blockers > 0 ? ` (${blockers} blocker${blockers === 1 ? '' : 's'})` : ''}`
            : 'Comments only';
        m.set(r.prUrl, {
          reviewId: r.reviewId,
          verdict: r.verdict,
          blockers,
          errors,
          warnings,
          summary,
          reviewedAt: Date.parse(r.createdAt) || Date.now(),
        });
      }
    } catch { /* review store best-effort */ }
    return m;
  }

  function trackedPRsForBroadcast(): TrackedPRWithReview[] {
    const reviewMap = reviewMapByPrUrl();
    return Array.from(trackedPRs.values()).map((pr) => ({
      ...pr,
      review: reviewMap.get(pr.url) ?? null,
    }));
  }

  async function refreshTrackedPRs(): Promise<void> {
    if (trackedPRs.size === 0) return;
    let changed = false;
    for (const [url] of trackedPRs) {
      const updated = await fetchPRDetails(url);
      if (updated) {
        const existing = trackedPRs.get(url);
        if (!existing || existing.status !== updated.status || existing.updatedAt !== updated.updatedAt) {
          trackedPRs.set(url, updated);
          changed = true;
        }
      }
    }
    if (changed) {
      deps.services.system.emit('prs.updated', { prs: trackedPRsForBroadcast() } as never);
    }
  }

  async function trackPR(prUrl: string): Promise<void> {
    if (trackedPRs.has(prUrl)) return;
    const pr = await fetchPRDetails(prUrl);
    if (pr) {
      trackedPRs.set(prUrl, pr);
      deps.services.system.emit('prs.updated', { prs: trackedPRsForBroadcast() } as never);
    }
  }

  async function loadPRsFromFeatureStore(): Promise<void> {
    try {
      const allFeatures = deps.featureStore.listFeatures();
      const prUrls = new Set<string>();
      for (const f of allFeatures) {
        if (f.prUrls && f.prUrls.length > 0) {
          for (const url of f.prUrls) prUrls.add(url);
        }
        const shipMd = deps.featureStore.readArtifact(f.project, f.slug, 'SHIP.md');
        if (shipMd) {
          const urls = extractPRUrls(shipMd);
          for (const url of urls) prUrls.add(url);
        }
      }
      if (prUrls.size > 0) {
        for (const url of prUrls) {
          await trackPR(url);
        }
      }
    } catch {
      // feature-store PR backfill is best-effort.
    }
  }

  function startPolling(intervalMs = 30_000): () => void {
    const handle = setInterval(() => {
      refreshTrackedPRs().catch(() => { /* swallow */ });
    }, intervalMs);
    if (typeof handle.unref === 'function') handle.unref();
    return () => { clearInterval(handle); };
  }

  return {
    extractPRUrls,
    fetchPRDetails,
    trackedPRsForBroadcast,
    refreshTrackedPRs,
    trackPR,
    loadPRsFromFeatureStore,
    startPolling,
  };
}
