/**
 * Legacy-pipeline canceller (Phase 3 round-12 extraction from
 * `dashboard-server.ts`).
 *
 * `cancelLegacyPipeline(deps)` SIGTERMs any running pipeline-child
 * process, flips its persisted `state.json` snapshot to `cancelled`
 * + marks every running/pending stage as failed/skipped, and emits a
 * `state` broadcast so the UI updates immediately.
 *
 * Pre-dates the `PipelineRunner` path — kept only as a fallback for
 * the `cancel-pipeline` WS action when no runner is active.
 * `getActiveChild`/`setActiveChild` callbacks reach into the boot
 * scope so the `let activeChild` binding stays canonical.
 */
import { writeFileSync, renameSync } from 'node:fs';
import { readStateFile } from '../runs/io.js';
export function createCancelLegacyPipeline(deps) {
    return function cancelLegacyPipeline() {
        const child = deps.getActiveChild();
        if (child) {
            child.kill('SIGTERM');
            deps.setActiveChild(null);
        }
        const state = readStateFile(deps.stateFile);
        if (state.activePipeline) {
            state.activePipeline.status = 'cancelled';
            for (const stage of state.activePipeline.stages) {
                if (stage.status === 'running' || stage.status === 'pending') {
                    stage.status = stage.status === 'running' ? 'failed' : 'skipped';
                    stage.completedAt = new Date().toISOString();
                }
            }
            state.lastUpdated = new Date().toISOString();
            try {
                const tmp = deps.stateFile + '.tmp';
                writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
                renameSync(tmp, deps.stateFile);
            }
            catch { /* ignore */ }
        }
        deps.broadcastState();
    };
}
//# sourceMappingURL=cancel-legacy.js.map