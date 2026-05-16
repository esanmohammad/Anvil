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
import { join } from 'node:path';
import { CostBreachHandler } from '../cost-breach-handler.js';
import { CostBreachSweeper } from '../cost-breach-sweeper.js';
import { notifyCostBreach } from '../pipeline-notifier.js';
export function createCostBreachRouter(deps) {
    const breachLogDir = join(deps.anvilHome, 'cost-breaches');
    const handler = new CostBreachHandler({
        ledger: deps.costLedger,
        storeDir: breachLogDir,
        onNotify: (state, topSpenders) => {
            deps.services.cost.emit('cost.breach', { breach: state, topSpenders });
            void notifyCostBreach({
                runId: state.runId,
                project: state.project,
                currentUsd: state.currentUsdAtBreach,
                limitUsd: state.limitUsdAtBreach,
                projectedUsd: state.currentUsdAtBreach * 1.2,
                graceEndsAt: state.graceEndsAt,
                topSpenders,
            });
            // Push the new snapshot so subscribers' modals/meters reflect the breach.
            try {
                deps.broadcastCostSnapshotRef.current(state.project, state.runId);
            }
            catch { /* ok */ }
        },
        onRejectStop: (runId) => {
            const run = deps.activeRuns.get(runId);
            if (run) {
                if (run.agentId) {
                    try {
                        deps.agentManager.kill(run.agentId);
                    }
                    catch { /* ok */ }
                }
                const runner = deps.getActivePipelineRunner();
                if (run.type === 'build' && runner) {
                    try {
                        runner.cancel();
                    }
                    catch { /* ok */ }
                }
                for (const [agentId, rid] of deps.agentToRunId.entries()) {
                    if (rid === runId) {
                        try {
                            deps.agentManager.kill(agentId);
                        }
                        catch { /* ok */ }
                    }
                }
                run.status = 'failed';
            }
            // Phase 3.A: typed RunService. Reason fixed at 'cost-breach' since
            // this is the only emit site (cost-breach handler).
            deps.services.runs.emit('run.rejected', { runId, reason: 'cost-breach' });
        },
    });
    const sweeper = new CostBreachSweeper(handler, { intervalMs: 5000 });
    sweeper.start();
    return {
        handler,
        sweeper,
        breachLogDir,
        stop: () => { try {
            sweeper.stop();
        }
        catch { /* ignore */ } },
    };
}
//# sourceMappingURL=cost-breach-router.js.map