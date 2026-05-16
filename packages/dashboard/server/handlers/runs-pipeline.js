/**
 * Pipeline + spawn-agent routes (Phase 2.6 / migration of remaining
 * closure-dependent cases).
 *
 * These handlers proxy through to closures still owned by
 * `dashboard-server.ts` via `deps.extras.pipelineActions`. Once a future
 * phase moves the closures into a `server/pipeline/*` module, only the
 * boot side rewires — the handler call-shape is unchanged.
 *
 * Migrated:
 *   - run-pipeline
 *   - resume / resume-pipeline (replay button)
 *   - spawn-agent
 *   - stop-run
 *   - run-fix / run-review / run-spike (quick actions)
 */
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { route } from './route.js';
import * as Z from './schemas.js';
export function runsPipelineRoutes() {
    return {
        'run-pipeline': route({
            input: Z.RunPipeline,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const actions = deps.extras.pipelineActions;
                if (!actions)
                    return;
                // Legacy path was `if (!msg.project || !msg.feature)` — the Zod
                // schema enforces both as required, so the parse failure already
                // covers the missing-fields case.
                actions.startPipeline(input.project, input.feature, input.options);
            },
        }),
        'resume': route({
            input: Z.ResumePipeline,
            handle: async (input, deps) => doResume(input, deps),
        }),
        'resume-pipeline': route({
            input: Z.ResumePipeline,
            handle: async (input, deps) => doResume(input, deps),
        }),
        'spawn-agent': route({
            input: Z.SpawnAgent,
            handle: (input, deps) => {
                const handle = deps.extras.agentManagerHandle;
                const kbRich = deps.extras.kbManagerRich;
                const getWs = deps.extras.getWorkspaceFromConfig;
                if (!handle)
                    return;
                const { project, feature, name, persona, stage, projectPrompt, options } = input;
                const configWs = getWs?.(project);
                const cwd = (configWs && existsSync(configWs))
                    ? configWs
                    : join(process.env.ANVIL_WORKSPACE_ROOT
                        || process.env.FF_WORKSPACE_ROOT
                        || join(homedir(), 'workspace'), project);
                let agentProjectPrompt = projectPrompt;
                if (!agentProjectPrompt && kbRich) {
                    const indexPrompt = kbRich.getIndexForPrompt(project);
                    let kbContent = '';
                    if (indexPrompt) {
                        const queryCtx = kbRich.getQueryContextForPrompt(project, feature);
                        kbContent = `${indexPrompt}\n\n---\n\n${queryCtx}`;
                    }
                    else {
                        kbContent = kbRich.getAllGraphReports(project);
                    }
                    if (kbContent) {
                        agentProjectPrompt = `You are a senior engineer working on the "${project}" project.\n\n## Codebase Knowledge Graph\nCRITICAL: Read and use this pre-computed architectural analysis BEFORE exploring files. It is your primary source of understanding.\n\n${kbContent}`;
                    }
                }
                const agentState = handle.spawn({
                    name: name ?? 'agent',
                    persona: persona ?? 'engineer',
                    project,
                    stage: stage ?? 'general',
                    prompt: feature,
                    model: options?.model ?? 'sonnet',
                    cwd,
                    projectPrompt: agentProjectPrompt,
                });
                deps.ws.send(JSON.stringify({ type: 'agent-spawned', payload: agentState }));
            },
        }),
        'stop-run': route({
            input: Z.StopRun,
            handle: (input, deps) => {
                const { runId } = input;
                const activeRuns = deps.extras.activeRuns;
                const agentToRunId = deps.extras.agentToRunId;
                const broadcastActiveRuns = deps.extras.broadcastActiveRuns;
                const broadcastRuns = deps.extras.broadcastRuns;
                const handle = deps.extras.agentManagerHandle;
                const getRunner = deps.extras.getActivePipelineRunner;
                if (!activeRuns)
                    return;
                const run = activeRuns.get(runId);
                if (!run)
                    return;
                // 1. Flip status + broadcast IMMEDIATELY so the UI reflects the
                //    stop before the kill chain unwinds.
                run.status = 'failed';
                deps.services.runs.emit('run.stopped', { runId });
                broadcastActiveRuns?.();
                // 2. Cancel the runner first.
                if (run.type === 'build') {
                    try {
                        getRunner?.()?.cancel();
                    }
                    catch { /* ok */ }
                }
                // 3. Kill every spawned agent mapped to this run.
                const toKill = new Set();
                if (run.agentId)
                    toKill.add(run.agentId);
                if (agentToRunId) {
                    for (const [agentId, rid] of agentToRunId.entries()) {
                        if (rid === runId)
                            toKill.add(agentId);
                    }
                }
                for (const agentId of toKill) {
                    try {
                        handle?.kill(agentId);
                    }
                    catch { /* already dead */ }
                    agentToRunId?.delete(agentId);
                }
                // Persist quick-action stop record (build runs are persisted by
                // the pipeline-fail handler via cancel()).
                if (run.type !== 'build') {
                    try {
                        const runsDir = deps.extras.runsDir;
                        const runsIndex = deps.extras.runsIndex;
                        if (runsDir && runsIndex) {
                            const runRecord = {
                                id: run.id,
                                project: run.project,
                                feature: run.description,
                                featureSlug: '',
                                status: 'cancelled',
                                model: run.model,
                                type: run.type,
                                createdAt: new Date(run.startedAt).toISOString(),
                                updatedAt: new Date().toISOString(),
                                durationMs: Date.now() - run.startedAt,
                                totalCost: 0,
                                repoNames: [],
                                prUrls: [],
                                stages: [{
                                        name: run.type,
                                        label: run.type === 'fix' ? 'Bug Fix' : 'Research',
                                        status: 'cancelled',
                                        cost: 0,
                                        startedAt: new Date(run.startedAt).toISOString(),
                                        completedAt: new Date().toISOString(),
                                        error: 'Stopped by user',
                                        repos: [],
                                    }],
                            };
                            if (!existsSync(runsDir))
                                mkdirSync(runsDir, { recursive: true });
                            appendFileSync(runsIndex, JSON.stringify(runRecord) + '\n', 'utf-8');
                        }
                    }
                    catch { /* */ }
                }
                activeRuns.delete(runId);
                broadcastActiveRuns?.();
                broadcastRuns?.();
            },
        }),
        'run-fix': quickActionRoute('run-fix'),
        'run-review': quickActionRoute('run-review'),
        'run-spike': quickActionRoute('run-spike'),
    };
}
function quickActionRoute(action) {
    return route({
        input: Z.RunQuickAction,
        onParseFail: 'silent',
        handle: (input, deps) => {
            const actions = deps.extras.pipelineActions;
            if (!actions)
                return;
            actions.spawnQuickAction(action, input.project, input.feature, input.options?.model);
        },
    });
}
async function doResume(input, deps) {
    const actions = deps.extras.pipelineActions;
    const featureStore = deps.extras.featureStore;
    const loadRunsSync = deps.extras.loadRunsSync;
    if (!actions || !featureStore)
        return;
    const runId = input.runId ?? '';
    const resumeSlug = input.featureSlug;
    const resumeProject = input.project;
    if (!runId && !resumeSlug)
        return;
    let checkpoint = null;
    if (resumeSlug && resumeProject) {
        const { readCheckpoint } = await import('../pipeline-runner.js');
        const featureDir = featureStore.getFeatureDir(resumeProject, resumeSlug);
        checkpoint = readCheckpoint(featureDir);
    }
    let prevRun;
    if (!checkpoint && runId && loadRunsSync) {
        const allRuns = loadRunsSync();
        prevRun = allRuns.find((r) => r.id === runId);
        if (prevRun?.featureSlug) {
            const { readCheckpoint } = await import('../pipeline-runner.js');
            const featureDir = featureStore.getFeatureDir(prevRun.project, prevRun.featureSlug);
            checkpoint = readCheckpoint(featureDir);
        }
    }
    if (!checkpoint && !prevRun) {
        deps.ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Run ${runId || resumeSlug} not found. No checkpoint or run record available.` },
        }));
        return;
    }
    const stages = (checkpoint?.stages ?? prevRun?.stageDetails ?? []);
    const failedIdx = stages.findIndex((s) => s.status === 'failed');
    const pendingIdx = stages.findIndex((s) => s.status === 'pending');
    const runningIdx = stages.findIndex((s) => s.status === 'running');
    let resumeFrom;
    let failureContext;
    if (failedIdx >= 0) {
        resumeFrom = failedIdx;
        const failedStage = stages[failedIdx];
        failureContext = `Stage "${failedStage.label}" failed${failedStage.error ? ': ' + failedStage.error : ''}. Fix the issues and continue.`;
    }
    else if (runningIdx >= 0) {
        resumeFrom = runningIdx;
        failureContext = `Pipeline was interrupted during "${stages[runningIdx].label}". Continue from where it left off.`;
    }
    else if (pendingIdx >= 0) {
        resumeFrom = pendingIdx;
        failureContext = `Pipeline was stopped before "${stages[pendingIdx].label}". Continue from this stage.`;
    }
    else {
        deps.ws.send(JSON.stringify({
            type: 'error',
            payload: { message: 'All stages already completed. Nothing to resume.' },
        }));
        return;
    }
    const cpConfig = checkpoint?.config;
    const project = checkpoint?.project ?? prevRun?.project ?? resumeProject ?? '';
    const feature = checkpoint?.feature ?? prevRun?.feature ?? '';
    const slug = checkpoint?.featureSlug ?? prevRun?.featureSlug ?? resumeSlug ?? '';
    const model = cpConfig?.model ?? prevRun?.model ?? input.options?.model ?? 'sonnet';
    console.log(`[dashboard] Resuming "${feature}" from stage ${resumeFrom} (${stages[resumeFrom]?.name ?? 'unknown'}) [source: ${checkpoint ? 'checkpoint' : 'runs-index'}]`);
    actions.startPipeline(project, feature, {
        model,
        baseBranch: cpConfig?.baseBranch ?? input.options?.baseBranch,
        skipClarify: resumeFrom > 0,
        skipShip: cpConfig?.skipShip,
        resumeFromStage: resumeFrom,
        featureSlug: slug,
        failureContext,
    });
}
//# sourceMappingURL=runs-pipeline.js.map