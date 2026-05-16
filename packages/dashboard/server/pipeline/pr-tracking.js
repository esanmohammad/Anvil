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
import { PR_URL_REGEX } from '@esankhan3/anvil-core-pipeline';
export function createPrTracker(deps) {
    const trackedPRs = new Map();
    function extractPRUrls(text) {
        PR_URL_REGEX.lastIndex = 0;
        const matches = text.match(PR_URL_REGEX);
        return matches ? [...new Set(matches)] : [];
    }
    async function fetchPRDetails(prUrl) {
        try {
            const result = execSync(`gh pr view "${prUrl}" --json number,title,headRepository,author,state,url,createdAt,updatedAt,additions,deletions,reviewRequests,labels,isDraft,reviewDecision`, { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
            const data = JSON.parse(result);
            let status = 'open';
            if (data.isDraft)
                status = 'draft';
            else if (data.state === 'MERGED')
                status = 'merged';
            else if (data.state === 'CLOSED')
                status = 'closed';
            // `in_review` = waiting on a reviewer. APPROVED PRs stay 'open' —
            // the board shouldn't park them in a column that implies more
            // reviewer work is needed.
            else if (data.reviewDecision === 'CHANGES_REQUESTED'
                || (data.reviewRequests && data.reviewRequests.length > 0))
                status = 'in_review';
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
                    .map((r) => r.login ?? r.name ?? '')
                    .filter(Boolean),
                labels: (data.labels ?? [])
                    .map((l) => l.name ?? '')
                    .filter(Boolean),
            };
        }
        catch {
            // `gh pr view` failures (auth, network, ETIMEDOUT on cancellation
            // cleanup) shouldn't spam the terminal — silently ignore. The PR
            // still surfaces via the activity-log scanner if it ever appears
            // in agent output.
            return null;
        }
    }
    function reviewMapByPrUrl() {
        const m = new Map();
        try {
            const all = deps.reviewStore.listReviews(undefined, 500);
            for (const r of all) {
                if (m.has(r.prUrl))
                    continue;
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
        }
        catch { /* review store best-effort */ }
        return m;
    }
    function trackedPRsForBroadcast() {
        const reviewMap = reviewMapByPrUrl();
        return Array.from(trackedPRs.values()).map((pr) => ({
            ...pr,
            review: reviewMap.get(pr.url) ?? null,
        }));
    }
    async function refreshTrackedPRs() {
        if (trackedPRs.size === 0)
            return;
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
            deps.services.system.emit('prs.updated', { prs: trackedPRsForBroadcast() });
        }
    }
    async function trackPR(prUrl) {
        if (trackedPRs.has(prUrl))
            return;
        const pr = await fetchPRDetails(prUrl);
        if (pr) {
            trackedPRs.set(prUrl, pr);
            deps.services.system.emit('prs.updated', { prs: trackedPRsForBroadcast() });
        }
    }
    async function loadPRsFromFeatureStore() {
        try {
            const allFeatures = deps.featureStore.listFeatures();
            const prUrls = new Set();
            for (const f of allFeatures) {
                if (f.prUrls && f.prUrls.length > 0) {
                    for (const url of f.prUrls)
                        prUrls.add(url);
                }
                const shipMd = deps.featureStore.readArtifact(f.project, f.slug, 'SHIP.md');
                if (shipMd) {
                    const urls = extractPRUrls(shipMd);
                    for (const url of urls)
                        prUrls.add(url);
                }
            }
            if (prUrls.size > 0) {
                for (const url of prUrls) {
                    await trackPR(url);
                }
            }
        }
        catch {
            // feature-store PR backfill is best-effort.
        }
    }
    function startPolling(intervalMs = 30_000) {
        const handle = setInterval(() => {
            refreshTrackedPRs().catch(() => { });
        }, intervalMs);
        if (typeof handle.unref === 'function')
            handle.unref();
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
//# sourceMappingURL=pr-tracking.js.map