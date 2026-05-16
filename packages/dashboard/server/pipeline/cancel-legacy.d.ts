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
import type { ChildProcess } from 'node:child_process';
export interface CancelLegacyDeps {
    stateFile: string;
    getActiveChild: () => ChildProcess | null;
    setActiveChild: (c: ChildProcess | null) => void;
    broadcastState: () => void;
}
export declare function createCancelLegacyPipeline(deps: CancelLegacyDeps): () => void;
//# sourceMappingURL=cancel-legacy.d.ts.map