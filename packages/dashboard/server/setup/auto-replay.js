/**
 * Auto-replay pump (Phase 3 round-6 extraction from
 * `dashboard-server.ts`).
 *
 * Drains the auto-replay queue every 15s. Each pass dispatches up to
 * `maxConcurrent` jobs to the bug-replay pipeline. Failures are
 * retried with backoff via the queue's internal `attempts` counter;
 * jobs that exceed `maxAttempts` drop.
 *
 * Returns a `stop()` fn — push it into `stopHandlers` so the
 * dashboard's graceful shutdown clears the interval.
 */
export function startAutoReplayPump(deps) {
    const intervalMs = deps.intervalMs ?? 15_000;
    const handle = setInterval(() => {
        void deps.autoReplayQueue.pump(async (job) => {
            const { runReplayPipeline } = await import('../replay-pipeline.js');
            const repoLocalPaths = deps.projectLoader.getRepoLocalPaths(job.project);
            const result = await runReplayPipeline({
                incidentStore: deps.incidentStore,
                replayStore: deps.replayStore,
                specStore: deps.testSpecStore,
                caseStore: deps.testCaseStore,
                learningsStore: deps.testLearningsStore,
                agentManager: deps.agentManager,
                project: job.project,
                incidentId: job.incidentId,
                repoLocalPaths,
                onStep: (step, state) => deps.services.incidents.emit('replay.step', { incidentId: job.incidentId, step, state }),
            });
            if (result.boundFilePath) {
                try {
                    deps.boundTestsStore.appendBound(job.project, {
                        filePath: result.boundFilePath,
                        incidentId: job.incidentId,
                        replayId: result.attempt.id,
                        addedAt: new Date().toISOString(),
                    });
                }
                catch { /* ok */ }
            }
            deps.services.incidents.emit('replay.complete', {
                result,
                incidentId: job.incidentId,
                attempt: result.attempt,
                boundFilePath: result.boundFilePath,
            });
        }).catch((err) => {
            console.warn('[auto-replay] pump cycle failed:', err);
        });
    }, intervalMs);
    // unref so the interval doesn't block process exit during tests / SIGTERM.
    if (typeof handle.unref === 'function')
        handle.unref();
    return {
        stop: () => { try {
            clearInterval(handle);
        }
        catch { /* ok */ } },
    };
}
//# sourceMappingURL=auto-replay.js.map