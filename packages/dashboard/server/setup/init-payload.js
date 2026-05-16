/**
 * Init-payload sender (Phase 3 round-7 extraction from
 * `dashboard-server.ts`).
 *
 * `createInitSender(deps)` returns the `sendInit(ws)` closure called
 * for every newly-connected socket.io client. The function packs:
 *   - project summaries (from `projectLoader.listProjects`)
 *   - run history (`loadRunsSync`)
 *   - dashboard state (`readStateFile`)
 *   - feature records
 *   - tracked PRs (`trackedPRsForBroadcast`)
 *   - active runs snapshot
 *   - discovered models
 *
 * It also pre-warms the broadcaster's dedup string so the next state
 * watcher tick won't re-emit a `state` event identical to the one
 * embedded in this frame, then replays the accumulated `outputBuffer`
 * so the connecting client catches up on agent activity that fired
 * before it subscribed.
 *
 * The factory takes a `getOutputBuffer()` getter (rather than the
 * array directly) because dashboard-server rebinds `outputBuffer`
 * on every pipeline / quick-action start.
 */
export function createInitSender(deps) {
    return async function sendInit(ws) {
        try {
            // Load projects and discover models in parallel to avoid waterfalls
            const [projects, availableModels] = await Promise.all([
                deps.projectLoader.listProjects(),
                deps.discoverAvailableModels().catch(() => ({ providers: [], defaultModel: 'sonnet', defaultProvider: 'claude' })),
            ]);
            const projectInfos = projects.map((s) => ({
                name: s.name,
                title: s.title,
                owner: s.owner,
                lifecycle: s.lifecycle,
                repoCount: s.repos.length,
                repos: s.repos.map((r) => ({ name: r.name, language: r.language, github: r.github })),
            }));
            const runs = deps.loadRunsSync();
            const features = deps.featureStore.listFeatures();
            const state = deps.readStateFile();
            // Pre-warm the broadcaster's dedup string so the next watcher tick
            // doesn't re-emit a `state` event identical to the one embedded in
            // the init frame below.
            deps.broadcaster.primeStateDedup();
            const initFrame = JSON.stringify({
                type: 'init',
                payload: {
                    projects: projectInfos, runs, state, features,
                    prs: deps.trackedPRsForBroadcast(),
                    activeRuns: Array.from(deps.activeRuns.values()).map((r) => ({
                        id: r.id, type: r.type, project: r.project, description: r.description,
                        model: r.model, status: r.status, startedAt: r.startedAt,
                        activityCount: r.activities.length,
                    })),
                    availableModels,
                },
            });
            if (process.env.ANVIL_WS_DIAG) {
                console.warn('[srv-diag] sending init bytes=', initFrame.length, 'readyState=', ws.readyState);
            }
            ws.send(initFrame);
            // Send accumulated output
            const buffer = deps.getOutputBuffer();
            if (buffer.length > 0) {
                ws.send(JSON.stringify({
                    type: 'agent-output',
                    payload: { entries: buffer },
                }));
            }
        }
        catch (err) {
            console.error('[dashboard] Error sending init:', err);
        }
    };
}
//# sourceMappingURL=init-payload.js.map