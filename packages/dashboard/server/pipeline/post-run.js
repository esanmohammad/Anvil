/**
 * Post-run persistence (Phase 3 extraction from `dashboard-server.ts`).
 *
 * `createPostRunPersister(deps)` returns a single async function the
 * pipeline lifecycle calls when a run terminates. The body is unchanged
 * from the legacy `persistRunRecord` closure:
 *
 *   1. Append a comprehensive run record to `<anvilHome>/runs/index.jsonl`.
 *   2. Record in the feature store's per-feature history.
 *   3. Update the feature record (status + cost + PR URLs).
 *   4. `recordPrEpisode` for completed runs that produced a PR.
 *   5. `reflectOnRun` — extract typed lessons via the memory-core
 *      proposal queue, gated by `ANVIL_REFLECTION`.
 *
 * Why a factory: the underlying memoryStore + agentManager + featureStore
 * live inside `startDashboardServer`'s closure. Passing them via a deps
 * object keeps this module a pure-function over its inputs.
 */
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
export function createPostRunPersister(deps) {
    return async function persistRunRecord(state, runId) {
        const now = new Date().toISOString();
        const startTime = new Date(state.startedAt).getTime();
        const durationMs = Date.now() - startTime;
        const activeRun = runId ? deps.activeRuns.get(runId) : null;
        const prUrls = activeRun ? Array.from(activeRun.prUrls) : [];
        const runRecord = {
            id: state.runId,
            project: state.project,
            feature: state.feature,
            featureSlug: state.featureSlug,
            status: state.status,
            model: state.model,
            createdAt: state.startedAt,
            updatedAt: now,
            durationMs,
            totalCost: state.totalCost,
            repoNames: state.repoNames,
            prUrls,
            stages: state.stages.map((s) => ({
                name: s.name,
                label: s.label,
                status: s.status,
                cost: s.cost,
                startedAt: s.startedAt,
                completedAt: s.completedAt,
                error: s.error,
                perRepo: s.perRepo,
                repos: s.repos.map((r) => ({
                    repoName: r.repoName,
                    status: r.status,
                    cost: r.cost,
                    error: r.error,
                })),
            })),
        };
        // 1. Append to RUNS_INDEX (JSONL)
        try {
            if (!existsSync(deps.runsDir))
                mkdirSync(deps.runsDir, { recursive: true });
            appendFileSync(deps.runsIndex, JSON.stringify(runRecord) + '\n', 'utf-8');
            console.log(`[dashboard] Run ${state.runId} persisted to ${deps.runsIndex}`);
        }
        catch (err) {
            console.error('[dashboard] Failed to write run to index:', err);
        }
        // 2. Record in feature store
        try {
            deps.featureStore.recordRun(state.project, state.featureSlug, state.runId, runRecord);
        }
        catch (err) {
            console.warn('[dashboard] Failed to record run in feature store:', err);
        }
        // 3. Update feature record
        try {
            deps.featureStore.updateFeature(state.project, state.featureSlug, {
                status: state.status === 'completed' ? 'completed' : 'failed',
                totalCost: state.totalCost,
                prUrls,
                repos: state.repoNames,
            });
        }
        catch (err) {
            console.warn('[dashboard] Failed to update feature record:', err);
        }
        // 4. PR episode memory (auto-ratified)
        if (state.status === 'completed' && prUrls.length > 0) {
            try {
                const { recordPrEpisode } = await import('@esankhan3/anvil-memory-core');
                for (const prUrl of prUrls) {
                    const payload = enrichPrEpisodePayload(prUrl);
                    recordPrEpisode(deps.memoryStore.unwrap(), {
                        prUrl,
                        intent: state.feature,
                        plan: state.featureSlug,
                        filesChanged: payload.filesChanged,
                        commitShas: payload.commitShas,
                        testsAdded: payload.testsAdded,
                        ciStatus: 'pending',
                        durationMs: Date.now() - new Date(state.startedAt ?? Date.now()).getTime(),
                        costUsd: state.totalCost ?? 0,
                    }, {
                        namespace: { scope: 'project', projectId: state.project },
                        runId: state.runId,
                    });
                }
            }
            catch (err) {
                console.warn('[dashboard] recordPrEpisode failed:', err);
            }
        }
        // 4b. Reflect-on-run
        // Default `on-success` (changed from `always` 2026-05-21): failed-run
        // reflection is high-noise because the model speculates about causes
        // it couldn't see; ~half of dashboard runs in the wild fail or cancel,
        // so this cuts reflection LLM cost in half with negligible signal
        // loss. Operators who want failure analysis set ANVIL_REFLECTION=always.
        const reflectionMode = (process.env.ANVIL_REFLECTION ?? 'on-success').toLowerCase();
        const reflectionDisabled = ['off', '0', 'false', 'no'].includes(reflectionMode);
        const shouldReflect = !reflectionDisabled &&
            (reflectionMode !== 'on-success' || state.status === 'completed');
        if (shouldReflect) {
            try {
                const { reflectOnRun, ProposalQueue } = await import('@esankhan3/anvil-memory-core');
                const { createReflectionInvoker } = await import('../reflection-invoker.js');
                const queue = new ProposalQueue(deps.memoryStore.unwrap().sqlite);
                const invoker = createReflectionInvoker({
                    agentManager: deps.agentManager,
                    project: state.project,
                    runId: state.runId,
                    cwd: deps.getWorkspaceFromConfig(state.project)
                        || join(deps.anvilHome, 'workspaces', state.project),
                });
                const stageSummary = state.stages.map((s) => `- ${s.label} [${s.status}]${s.error ? `: ${s.error.slice(0, 200)}` : ''}`).join('\n');
                const runSummary = [
                    `Project: ${state.project}`,
                    `Feature: ${state.feature}`,
                    `Outcome: ${state.status}`,
                    `Cost: $${(state.totalCost ?? 0).toFixed(2)}`,
                    `Repos: ${state.repoNames.join(', ') || '(none)'}`,
                    ``,
                    `Stages:`,
                    stageSummary,
                ].join('\n');
                const result = await reflectOnRun({
                    queue,
                    namespace: { scope: 'project', projectId: state.project },
                    runContext: { runId: state.runId, runSummary },
                    llmInvoke: invoker,
                });
                const totalProposals = result.proposalIds.length;
                console.log(`[dashboard] reflection enqueued ${totalProposals} proposal(s) for run ${state.runId}`);
            }
            catch (err) {
                console.warn('[dashboard] reflectOnRun failed:', err);
            }
        }
        // 5. Wave 4 — memory hit detection. Scan the run's combined stage
        //    outputs for substring matches against any memory injected into
        //    this run. Hits get `used=1` on the injection log AND a confidence
        //    + decay-strength bump on the memory itself, so high-value
        //    memories rank higher in future retrievals.
        try {
            detectMemoryHits(deps.memoryStore, state);
        }
        catch (err) {
            console.warn('[dashboard] memory hit detection failed:', err);
        }
    };
}
/**
 * Substring-match injected memories against the agent's accumulated
 * stage outputs. On match: flip the injection log's `used=1` AND apply
 * a retrieval bonus to the memory's confidence + decay strength.
 *
 * Tier 3 future-work: when embeddings are populated, switch to cosine
 * similarity. Substring catches the high-confidence cases (literal
 * pattern reuse, error-message echoes); cosine would catch the
 * paraphrased reuse.
 */
function detectMemoryHits(memoryStore, state) {
    const store = memoryStore.unwrap();
    // Wave 1 — injections are now recorded per stage. Pull every injection
    // for this run (union across stages); dedupe by memory id since the
    // same memory may have been injected to multiple stages.
    const records = store.injections.forRun(state.runId);
    if (records.length === 0)
        return;
    const uniqueIds = Array.from(new Set(records.map((r) => r.memoryId)));
    // Build the run's text corpus: per-stage outputs + errors + repo notes.
    const corpus = buildRunCorpus(state);
    if (!corpus.trim())
        return;
    let hits = 0;
    for (const id of uniqueIds) {
        const m = store.findById(id);
        if (!m)
            continue;
        if (memoryReusedInCorpus(m.content, corpus)) {
            // markUsed scopes to (runId, memoryId) — flips `used=1` for ALL
            // stages of this run that injected this memory.
            store.injections.markUsed(state.runId, id);
            store.applyRetrievalHit(id);
            hits += 1;
        }
    }
    if (hits > 0) {
        console.log(`[dashboard] memory hits run=${state.runId}: ${hits}/${uniqueIds.length} reused`);
    }
}
function buildRunCorpus(state) {
    const parts = [];
    for (const s of state.stages) {
        if (s.error)
            parts.push(s.error);
        for (const r of s.repos) {
            if (r.error)
                parts.push(r.error);
        }
    }
    return parts.join('\n');
}
/**
 * Returns true when `corpus` literally contains a recognizable signature
 * from a memory's content. We extract distinctive substrings (>= 12 chars)
 * from the content's normalized form — short tokens (≤ 11 chars) match
 * too freely (e.g. "error", "test"), bloating hit rates. A single match
 * of any signature is a hit.
 */
function memoryReusedInCorpus(content, corpus) {
    const text = typeof content === 'string' ? content : (() => {
        try {
            return JSON.stringify(content) ?? '';
        }
        catch {
            return '';
        }
    })();
    if (!text)
        return false;
    // Split into candidate signatures: phrases on whitespace, dedupe.
    // We're looking for substrings rare enough that random matches are
    // unlikely. ≥12 chars after trimming punctuation; cap at 8 sigs/memory.
    const signatures = new Set();
    for (const raw of text.split(/[\n.,;]+/g)) {
        const trimmed = raw.trim();
        if (trimmed.length >= 12)
            signatures.add(trimmed);
        if (signatures.size >= 8)
            break;
    }
    if (signatures.size === 0)
        return false;
    const corpusLower = corpus.toLowerCase();
    for (const sig of signatures) {
        if (corpusLower.includes(sig.toLowerCase()))
            return true;
    }
    return false;
}
/**
 * Enrich the PR-episode payload by querying `gh pr view` for the files
 * and commits that landed in the PR. Returns empty arrays on any failure
 * (gh CLI missing, network blip, malformed URL, rate limit) — the episode
 * still gets recorded with intent + plan, just without the file/commit
 * signal that makes per-file BM25 retrieval surgical.
 *
 * Hard 5-second cap on each gh subprocess so a hung shell doesn't block
 * post-run cleanup.
 */
function enrichPrEpisodePayload(prUrl) {
    const empty = { filesChanged: [], commitShas: [], testsAdded: [] };
    // Extract `<owner>/<repo>#<num>` argument shape for `gh pr view`.
    // `gh` accepts the URL directly, so just pass it through.
    const filesChanged = safeGhJson(['pr', 'view', prUrl, '--json', 'files', '--jq', '.files'])?.map((f) => f.path) ?? [];
    const commitShas = safeGhJson(['pr', 'view', prUrl, '--json', 'commits', '--jq', '.commits'])?.map((c) => c.oid) ?? [];
    const testsAdded = filesChanged.filter((p) => /(?:^|\/)__tests__\/|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/.test(p));
    // If both gh calls failed, return all-empty to keep telemetry honest —
    // no point reporting partial results that look like the PR is empty.
    if (filesChanged.length === 0 && commitShas.length === 0)
        return empty;
    return { filesChanged, commitShas, testsAdded };
}
function safeGhJson(args) {
    try {
        const out = execFileSync('gh', args, {
            encoding: 'utf8',
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(out);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=post-run.js.map