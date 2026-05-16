/**
 * Cost-breach router (Phase 3 round-5 extraction from
 * `dashboard-server.ts`).
 *
 * `createCostBreachRouter(deps)` constructs the project-wide
 * `CostBreachHandler` + its sweeper, wires the `onNotify` (typed
 * `cost.breach` emit + Slack/SMTP notify + cost-snapshot push) and
 * `onRejectStop` (kill the run's agents + flip status + emit
 * `run.rejected`) callbacks, and returns the handles so the
 * dashboard boot sequence can pass `handler` into the broadcaster and
 * register `stop()` with the shutdown sweeper.
 *
 * Chicken-and-egg note: `broadcastCostSnapshot` is destructured from
 * the broadcaster, but the broadcaster requires `costBreachHandler`
 * as a dep. The router takes a `{ current }` ref so the dashboard
 * can wire the real snapshot fn after both are constructed; the
 * legacy lexical-capture trick (TDZ-free because notify fires
 * post-construction) is preserved.
 */
import { CostBreachHandler } from '../cost-breach-handler.js';
import { CostBreachSweeper } from '../cost-breach-sweeper.js';
import type { CostLedger } from '../cost-ledger.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { DashboardServices } from '../services/index.js';
import type { ActiveRun } from '../broadcasts.js';
import type { PipelineRunner } from '../pipeline-runner.js';
export interface BroadcastCostSnapshotRef {
    current: (project: string, runId: string) => void;
}
export interface CostBreachRouterDeps {
    anvilHome: string;
    costLedger: CostLedger;
    agentManager: AgentManager;
    services: DashboardServices;
    activeRuns: Map<string, ActiveRun>;
    agentToRunId: Map<string, string>;
    getActivePipelineRunner: () => PipelineRunner | null;
    /**
     * Late-bound snapshot dispatcher. The dashboard wires
     * `ref.current = broadcastCostSnapshot` once the broadcaster has
     * been constructed (the broadcaster itself takes the handler from
     * this factory's output, so the wiring is two-phase by
     * construction).
     */
    broadcastCostSnapshotRef: BroadcastCostSnapshotRef;
}
export interface CostBreachRouterHandle {
    handler: CostBreachHandler;
    sweeper: CostBreachSweeper;
    /** Path to the breach log dir — pass into `services.cost.setDeps(...)`. */
    breachLogDir: string;
    /** Stop the sweeper. Safe to call multiple times. */
    stop(): void;
}
export declare function createCostBreachRouter(deps: CostBreachRouterDeps): CostBreachRouterHandle;
//# sourceMappingURL=cost-breach-router.d.ts.map