/**
 * Durable execution boot wiring (Phases D3 + F3 + F4 + G1).
 *
 * Three responsibilities at dashboard startup:
 *
 *   1. **Pattern-1 migration + orphan takeover** (`runDurableMigration`)
 *      — scans `~/.anvil/runs/` for in-flight audit logs not yet in
 *      durable table (Pattern-1 → Pattern-2 carry-over), and claims
 *      orphaned leases on crashed-peer runs (auto-takeover).
 *
 *   2. **Auto-resume dispatch** (`dispatchTakenOverRuns`) — after
 *      takeover, kicks off `startPipeline` for each reclaimed run so
 *      the replay loop continues from the durable cursor.
 *
 *   3. **Vacuum schedule** (`scheduleDurableVacuum`) — drops terminal
 *      runs older than the retention window (default 30d, override
 *      via `ANVIL_DURABLE_RETENTION_DAYS`).
 *
 * Returns a `stop()` fn — push it into `stopHandlers` for graceful
 * shutdown.
 */
export interface DurableBootDeps {
    /** Stage-name → index lookup (for resume-from-stage derivation). */
    stagesByName: Record<string, number>;
    /** Callback that kicks a pipeline run; required for auto-resume. */
    startPipeline: (project: string, feature: string, options?: Record<string, unknown>) => void;
}
export interface DurableBootHandle {
    stop: () => Promise<void>;
}
export declare function bootDurable(deps: DurableBootDeps): Promise<DurableBootHandle>;
//# sourceMappingURL=durable.d.ts.map