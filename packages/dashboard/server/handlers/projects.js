/**
 * Project-overview WS routes (Recipe 7 / Phase 1).
 *
 * Migrated (read-only, no closure deps beyond what extras already
 * holds):
 *   - get-interrupted-pipelines — `findInterruptedPipelines` dynamic-imported
 *   - get-branches               — git fetch + branch listing in the
 *                                  workspace dir; closure-resident
 *                                  `getWorkspaceFromConfig` lookup
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - get-state, get-projects   (`sendInit` closure)
 *   - get-features              (`featureStore.listFeatures` lookup)
 *   - get-runs, get-active-runs (`loadRunsSync`, `broadcastActiveRuns` closures)
 *   - get-run                   (reads `activeRuns` map + `featureStore`)
 *   - get-overview              (`buildProjectOverview` closure)
 *   - refresh-prs               (`refreshTrackedPRs` / `trackedPRsForBroadcast` closures)
 */
import { route } from './route.js';
import * as Z from './schemas.js';
export function projectRoutes() {
    return {
        /**
         * `rollback-run` — conservative cleanup of a completed/failed/cancelled
         * run's local changes:
         *   1. for each repo: if `anvil/<slug>` branch exists, check out
         *      base (origin/HEAD → main fallback), then delete the branch.
         *   2. mark the feature record `cancelled` so the UI hides it.
         *
         * Remote PR (if any) is left intact — closing it is the user's call
         * via `gh`. Per-repo results bubble back in the `rollback-done`
         * payload.
         */
        'rollback-run': route({
            input: Z.RollbackRun,
            handle: async (input, deps) => {
                const allRuns = (deps.extras.loadRunsSync?.() ?? []);
                const run = allRuns.find((r) => r.id === input.runId);
                if (!run)
                    return { error: 'run-not-found' };
                const { existsSync } = await import('node:fs');
                const { execSync } = await import('node:child_process');
                const repoPaths = deps.extras.projectLoader?.getRepoLocalPaths(run.project) ?? {};
                const branchName = `anvil/${run.featureSlug ?? ''}`;
                const results = [];
                for (const [repoName, path] of Object.entries(repoPaths)) {
                    if (!existsSync(path)) {
                        results.push({ repo: repoName, ok: false, detail: 'path missing' });
                        continue;
                    }
                    try {
                        execSync(`git rev-parse --verify "${branchName}"`, { cwd: path, stdio: 'pipe' });
                    }
                    catch {
                        results.push({ repo: repoName, ok: true, detail: 'no local branch' });
                        continue;
                    }
                    try {
                        // Prefer origin/HEAD for the base branch; fall back to main.
                        let base = 'main';
                        try {
                            const headRef = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
                                cwd: path, encoding: 'utf-8', stdio: 'pipe',
                            }).trim();
                            base = headRef.replace(/^refs\/remotes\/origin\//, '') || 'main';
                        }
                        catch { /* leave default */ }
                        const current = execSync('git rev-parse --abbrev-ref HEAD', {
                            cwd: path, encoding: 'utf-8', stdio: 'pipe',
                        }).trim();
                        if (current === branchName) {
                            execSync(`git checkout "${base}"`, { cwd: path, stdio: 'pipe' });
                        }
                        execSync(`git branch -D "${branchName}"`, { cwd: path, stdio: 'pipe' });
                        results.push({ repo: repoName, ok: true, detail: `deleted ${branchName}` });
                    }
                    catch (err) {
                        results.push({ repo: repoName, ok: false, detail: err instanceof Error ? err.message : String(err) });
                    }
                }
                try {
                    if (run.featureSlug) {
                        deps.extras.featureStore?.updateFeature?.(run.project, run.featureSlug, { status: 'cancelled' });
                    }
                }
                catch { /* ok */ }
                deps.extras.broadcastRuns?.();
                return { runId: input.runId, results, ok: results.every((r) => r.ok) };
            },
            wireType: 'rollback-done',
            errorMessage: (_code, input) => `Run ${input.runId} not found.`,
        }),
        'kill-agent': route({
            input: Z.KillAgent,
            onParseFail: 'silent',
            handle: (input, deps) => {
                if (input.agentId)
                    deps.extras.killAgent?.(input.agentId);
            },
        }),
        'send-input': route({
            input: Z.SendInput,
            onParseFail: 'silent',
            handle: (input, deps) => {
                if (input.text)
                    deps.extras.sendInput?.(input.text, input.agentId);
            },
        }),
        'cancel-pipeline': route({
            input: Z.CancelPipeline,
            onParseFail: 'silent',
            handle: (_input, deps) => { deps.extras.cancelPipeline?.(); },
        }),
        'get-state': route({
            input: Z.GetState,
            onParseFail: 'silent',
            handle: async (_input, deps) => { await deps.extras.sendInit?.(deps.ws); },
        }),
        'get-projects': route({
            input: Z.GetProjects,
            onParseFail: 'silent',
            // Reuse sendInit — it already returns the correct project + repo counts.
            handle: async (_input, deps) => { await deps.extras.sendInit?.(deps.ws); },
        }),
        'get-features': route({
            input: Z.GetFeatures,
            onParseFail: 'silent',
            handle: (input, deps) => deps.extras.featureStore?.listFeatures(input.project),
            wireType: 'features',
        }),
        'get-runs': route({
            input: Z.GetRuns,
            onParseFail: 'silent',
            handle: (_input, deps) => deps.extras.loadRunsSync?.(),
            wireType: 'runs',
        }),
        'get-active-runs': route({
            input: Z.GetActiveRuns,
            onParseFail: 'silent',
            // The broadcaster re-emits via `services.runs.emit('run.active-snapshot', …)`
            // which the bridge fans into the `runs` / `global` rooms. The requesting
            // socket gets it through normal subscription, so this is fire-and-forget.
            handle: (_input, deps) => { deps.extras.broadcastActiveRuns?.(); },
        }),
        'refresh-prs': route({
            input: Z.RefreshPRs,
            onParseFail: 'silent',
            handle: async (_input, deps) => {
                const refresh = deps.extras.refreshTrackedPRs;
                const snapshot = deps.extras.trackedPRsForBroadcast;
                if (!refresh || !snapshot)
                    return;
                try {
                    await refresh();
                    return snapshot();
                }
                catch {
                    // Legacy parity: silent on refresh failure.
                }
            },
            wireType: 'prs',
        }),
        /**
         * `get-run` — resolve a run id in three steps:
         *   1. live `activeRuns` map (has activities[] streamed in-memory)
         *   2. persisted `runs/index.jsonl` (has output + stage details)
         *   3. per-feature run files under `<anvilHome>/features/<p>/<s>/runs/`
         *
         * Each fallback layer emits its own `run-data` payload shape. The
         * legacy handler ran each layer in sequence with no echo on miss —
         * matched here.
         */
        'get-run': route({
            input: Z.GetRun,
            handle: async (input, deps) => {
                const live = deps.extras.activeRuns?.get(input.runId);
                if (live) {
                    deps.ws.send(JSON.stringify({
                        type: 'run-data',
                        payload: {
                            id: live.id, type: live.type, project: live.project,
                            description: live.description, model: live.model, status: live.status,
                            startedAt: live.startedAt, activities: live.activities,
                        },
                    }));
                    return;
                }
                const allRuns = (deps.extras.loadRunsSync?.() ?? []);
                const historic = allRuns.find((r) => r.id === input.runId);
                if (historic) {
                    deps.ws.send(JSON.stringify({
                        type: 'run-data',
                        payload: {
                            id: historic.id, type: historic.runType ?? 'build', project: historic.project,
                            description: historic.feature, model: historic.model, status: historic.status,
                            startedAt: historic.startedAt, totalCost: historic.totalCost,
                            durationMs: historic.durationMs, stageDetails: historic.stageDetails,
                            prUrls: historic.prUrls, output: historic.output, activities: [],
                        },
                    }));
                    return;
                }
                try {
                    const { existsSync, readFileSync } = await import('node:fs');
                    const { join } = await import('node:path');
                    const features = (deps.extras.featureStore?.listFeatures() ?? []);
                    for (const f of features) {
                        const runPath = join(deps.extras.anvilHome, 'features', f.project, f.slug, 'runs', `${input.runId}.json`);
                        if (existsSync(runPath)) {
                            const runData = JSON.parse(readFileSync(runPath, 'utf-8'));
                            deps.ws.send(JSON.stringify({ type: 'run-data', payload: { ...runData, activities: [] } }));
                            return;
                        }
                    }
                }
                catch { /* legacy silent */ }
                // Legacy parity: no reply on full miss.
            },
        }),
        'get-overview': route({
            input: Z.GetOverview,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                if (!deps.extras.buildProjectOverview)
                    return;
                return await deps.extras.buildProjectOverview(input.project ?? '');
            },
            wireType: 'overview',
        }),
        'get-interrupted-pipelines': route({
            input: Z.GetInterruptedPipelines,
            onParseFail: 'silent',
            handle: async (_input, deps) => {
                try {
                    const { findInterruptedPipelines } = await import('../pipeline-runner.js');
                    const interrupted = findInterruptedPipelines(deps.extras.anvilHome);
                    return {
                        pipelines: interrupted.map((cp) => ({
                            runId: cp.runId,
                            project: cp.project,
                            feature: cp.feature,
                            featureSlug: cp.featureSlug,
                            model: cp.config.model,
                            baseBranch: cp.config.baseBranch,
                            currentStage: cp.currentStage,
                            stageName: cp.stages[cp.currentStage]?.name ?? 'unknown',
                            stageLabel: cp.stages[cp.currentStage]?.label ?? 'Unknown',
                            totalCost: cp.totalCost,
                            startedAt: cp.startedAt,
                            error: cp.stages[cp.currentStage]?.error ?? 'Pipeline was interrupted',
                        })),
                    };
                }
                catch {
                    return { pipelines: [] };
                }
            },
            wireType: 'interrupted-pipelines',
        }),
        'get-branches': route({
            input: Z.GetBranches,
            onParseFail: 'silent',
            handle: async (input, deps) => {
                const { existsSync } = await import('node:fs');
                const { execSync } = await import('node:child_process');
                const { join } = await import('node:path');
                const project = input.project ?? '';
                const fallback = { branches: ['main'], default: 'main' };
                try {
                    const configWs = deps.extras.getWorkspaceFromConfig?.(project) ?? null;
                    const workspace = configWs || join(deps.extras.anvilHome, 'workspaces', project);
                    if (!existsSync(workspace))
                        return fallback;
                    // Find the first git repo in the workspace
                    let gitDir = workspace;
                    try {
                        const repoPaths = deps.extras.projectLoader?.getRepoLocalPaths(project) ?? {};
                        const firstPath = Object.values(repoPaths)[0];
                        if (firstPath && existsSync(join(firstPath, '.git')))
                            gitDir = firstPath;
                    }
                    catch { /* use workspace root */ }
                    // Fetch remote branches (best-effort).
                    try {
                        execSync('git fetch --prune 2>/dev/null', { cwd: gitDir, timeout: 15000, stdio: 'pipe' });
                    }
                    catch { /* ok */ }
                    const raw = execSync('git branch -r --no-color 2>/dev/null || echo "  origin/main"', {
                        cwd: gitDir, timeout: 5000, stdio: 'pipe',
                    }).toString();
                    const branches = raw.split('\n')
                        .map((b) => b.trim())
                        .filter((b) => b && !b.includes('->'))
                        .map((b) => b.replace(/^origin\//, ''))
                        .filter((b) => b)
                        .sort((a, b) => {
                        if (a === 'main' || a === 'master')
                            return -1;
                        if (b === 'main' || b === 'master')
                            return 1;
                        return a.localeCompare(b);
                    });
                    const defaultBranch = branches.includes('main') ? 'main'
                        : branches.includes('master') ? 'master'
                            : branches[0] || 'main';
                    return { branches, default: defaultBranch };
                }
                catch {
                    return fallback;
                }
            },
            wireType: 'branches',
        }),
    };
}
//# sourceMappingURL=projects.js.map