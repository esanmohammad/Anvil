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

import { getDurableStore } from '../durable-store-singleton.js';
import { runDurableMigration } from '../durable-migration.js';
import { dispatchTakenOverRuns } from '../durable-resume-queue.js';
import { scheduleDurableVacuum } from '../durable-vacuum.js';

export interface DurableBootDeps {
  /** Stage-name → index lookup (for resume-from-stage derivation). */
  stagesByName: Record<string, number>;
  /** Callback that kicks a pipeline run; required for auto-resume. */
  startPipeline: (project: string, feature: string, options?: Record<string, unknown>) => void;
}

export interface DurableBootHandle {
  stop: () => Promise<void>;
}

export async function bootDurable(deps: DurableBootDeps): Promise<DurableBootHandle> {
  const takenOverRunIds: string[] = [];

  // Phase D3 + F4 — migration + orphan takeover.
  try {
    const store = getDurableStore();
    const migrationStats = await runDurableMigration(store, {
      onTakeover: (runIds) => {
        console.log(
          `[dashboard] auto-takeover: claimed ${runIds.length} orphaned run(s) — ${runIds.join(', ')}`,
        );
        takenOverRunIds.push(...runIds);
      },
    });
    if (migrationStats.scanned > 0 || migrationStats.orphaned > 0 || migrationStats.takenOver > 0) {
      console.log(
        `[dashboard] durable migration: scanned=${migrationStats.scanned} migrated=${migrationStats.migrated} orphaned=${migrationStats.orphaned} takenOver=${migrationStats.takenOver} contested=${migrationStats.takeoverContested} errors=${migrationStats.errors}`,
      );
    }
  } catch (err) {
    console.warn(`[dashboard] durable migration skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Phase G1 — dispatch reclaimed runs.
  if (takenOverRunIds.length > 0) {
    const autoResumeEnabled = process.env.ANVIL_DURABLE_AUTO_RESUME === '1';
    if (autoResumeEnabled) {
      void dispatchTakenOverRuns(
        getDurableStore(),
        takenOverRunIds,
        (project, feature, options) => {
          deps.startPipeline(project, feature, options);
        },
        deps.stagesByName,
      ).then((stats) => {
        if (stats.dispatched > 0 || stats.errors > 0) {
          console.log(
            `[dashboard] auto-resume: attempted=${stats.attempted} dispatched=${stats.dispatched} skipped=${stats.skipped} errors=${stats.errors}`,
          );
        }
      });
    } else {
      // Auto-resume off — flip claimed orphans to `paused` so the UI
      // surfaces them as waiting-for-manual-Replay rather than
      // green-pulsing "running" that isn't actually executing.
      const store = getDurableStore();
      if (store) {
        void Promise.all(
          takenOverRunIds.map((runId) =>
            store.updateRunStatus(runId, 'paused').catch(() => { /* best-effort */ }),
          ),
        ).then(() => {
          console.log(
            `[dashboard] auto-resume disabled — ${takenOverRunIds.length} orphan(s) marked paused (use Replay button to resume manually)`,
          );
        });
      }
    }
  }

  // Phase F3 — vacuum schedule.
  let vacuumHandle: { stop: () => void } | null = null;
  try {
    const store = getDurableStore();
    vacuumHandle = await scheduleDurableVacuum(store);
  } catch (err) {
    console.warn(`[dashboard] durable vacuum schedule skipped: ${err instanceof Error ? err.message : err}`);
  }

  return {
    stop: async () => {
      try { vacuumHandle?.stop(); } catch { /* ok */ }
    },
  };
}
