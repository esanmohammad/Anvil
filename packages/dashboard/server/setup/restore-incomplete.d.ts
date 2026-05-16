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
import type { ActiveRun } from '../broadcasts.js';
import type { DashboardServices } from '../services/index.js';
export interface RestoreIncompleteDeps {
    anvilHome: string;
    activeRuns: Map<string, ActiveRun>;
    services: DashboardServices;
    broadcastActiveRuns: () => void;
    /** Override the post-restore broadcast delay (default 2s for client connect). */
    broadcastDelayMs?: number;
}
export declare function restoreIncompletePipelines(deps: RestoreIncompleteDeps): Promise<void>;
//# sourceMappingURL=restore-incomplete.d.ts.map