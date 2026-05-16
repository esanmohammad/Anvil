/**
 * Restore incomplete pipelines on startup (Phase 3 round-6 extraction
 * from `dashboard-server.ts`).
 *
 * Dynamic-imports `findInterruptedPipelines(ANVIL_HOME)`, seeds
 * `activeRuns` with each interrupted run so the Active Runs page is
 * populated immediately, then defers a `pipeline.interrupted-snapshot`
 * emit by 2s so clients have time to connect and subscribe to the
 * `pipeline` room before the snapshot arrives.
 *
 * Fire-and-forget; never throws.
 */
export async function restoreIncompletePipelines(deps) {
    const delay = deps.broadcastDelayMs ?? 2000;
    try {
        const { findInterruptedPipelines } = await import('../pipeline-runner.js');
        const incomplete = findInterruptedPipelines(deps.anvilHome);
        if (incomplete.length === 0)
            return;
        for (const cp of incomplete) {
            // Add to activeRuns so they appear in the Active Runs page
            deps.activeRuns.set(cp.runId, {
                id: cp.runId,
                type: 'build',
                project: cp.project,
                description: cp.feature,
                model: cp.config.model,
                status: cp.status === 'cancelled' ? 'failed' : cp.status,
                startedAt: new Date(cp.startedAt).getTime(),
                activities: [],
                prUrls: new Set(),
            });
        }
        // Broadcast to connected clients after a short delay
        setTimeout(() => {
            deps.broadcastActiveRuns();
            deps.services.pipeline.emit('pipeline.interrupted-snapshot', {
                pipelines: incomplete.map((cp) => ({
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
                    status: cp.status,
                    error: cp.stages[cp.currentStage]?.error ?? 'Pipeline was interrupted (dashboard shutdown)',
                })),
            });
        }, delay);
    }
    catch (err) {
        console.warn('[dashboard] Failed to scan for incomplete pipelines:', err);
    }
}
//# sourceMappingURL=restore-incomplete.js.map