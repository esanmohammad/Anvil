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
                    recordPrEpisode(deps.memoryStore.unwrap(), {
                        prUrl,
                        intent: state.feature,
                        plan: state.featureSlug,
                        filesChanged: [],
                        commitShas: [],
                        testsAdded: [],
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
        const reflectionMode = (process.env.ANVIL_REFLECTION ?? 'always').toLowerCase();
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
    };
}
//# sourceMappingURL=post-run.js.map