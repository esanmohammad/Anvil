/**
 * Durable-store vacuum scheduler — Phase F3.
 *
 * Runs the durable store's `vacuum()` operation:
 *   1. Once at dashboard boot (after the migration runner).
 *   2. Daily on a `setInterval` thereafter.
 *
 * Retention defaults follow `docs/durable-execution-plan.md` §H:
 *   - Terminal runs (`completed`/`failed`/`cancelled`) older than
 *     `RETENTION_DAYS` (default 30) are dropped along with their
 *     events + signals.
 *
 * Differential retention (90-day completed / 30-day failed) is a
 * future refinement that requires extending the `DurableStore`
 * vacuum API to accept a status filter; v1 ships with one cutoff
 * since aggressive cleanup is the safer default for an unbounded
 * SQLite WAL file in `~/.anvil/durable.db`.
 *
 * Override via `ANVIL_DURABLE_RETENTION_DAYS=<n>` (sets the cutoff
 * in days) or `ANVIL_DURABLE_VACUUM_DISABLED=1` to skip entirely.
 */

import type { DurableStore, VacuumStats } from '@esankhan3/anvil-core-pipeline';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export interface VacuumScheduleHandle {
  /** Stop the scheduled job. Returns immediately; in-flight vacuum completes. */
  stop(): void;
  /** Run the vacuum once, ignoring the schedule. Returns the stats. */
  runOnce(): Promise<VacuumStats>;
}

export interface VacuumOptions {
  /** Days of retention for terminal runs. Default 30. */
  retentionDays?: number;
  /** Schedule interval in ms. Default 24h. */
  intervalMs?: number;
  /** Override clock for tests. */
  now?: () => number;
  /** Receives vacuum stats per run; defaults to console.log when stats > 0. */
  onResult?: (stats: VacuumStats) => void;
}

function envRetentionDays(): number | undefined {
  const v = process.env.ANVIL_DURABLE_RETENTION_DAYS;
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function isDisabled(): boolean {
  return process.env.ANVIL_DURABLE_VACUUM_DISABLED === '1';
}

/**
 * Run the vacuum once. Used by the boot block + the scheduled job.
 * Logs to stderr on failure but never throws — the dashboard must
 * keep running.
 */
export async function runDurableVacuum(
  store: DurableStore | null,
  opts: VacuumOptions = {},
): Promise<VacuumStats> {
  const empty: VacuumStats = { runs: 0, events: 0, signals: 0 };
  if (!store || isDisabled()) return empty;

  const retentionDays = opts.retentionDays
    ?? envRetentionDays()
    ?? DEFAULT_RETENTION_DAYS;
  const now = opts.now ?? Date.now;
  const cutoffMs = now() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  try {
    const stats = await store.vacuum(cutoffIso);
    if (stats.runs > 0 || stats.events > 0 || stats.signals > 0) {
      const msg = `[durable-vacuum] removed runs=${stats.runs} events=${stats.events} signals=${stats.signals} (retention=${retentionDays}d)`;
      if (opts.onResult) opts.onResult(stats);
      else console.log(msg);
    }
    return stats;
  } catch (err) {
    console.warn(
      `[durable-vacuum] failed: ${err instanceof Error ? err.message : err}`,
    );
    return empty;
  }
}

/**
 * Schedule the vacuum at boot + at the configured interval.
 * Returns a handle the caller can call `.stop()` on during
 * shutdown to clear the interval.
 *
 * Calls runDurableVacuum once synchronously (awaited) so boot-time
 * cleanup happens before the WS server starts accepting requests.
 */
export async function scheduleDurableVacuum(
  store: DurableStore | null,
  opts: VacuumOptions = {},
): Promise<VacuumScheduleHandle> {
  if (!store || isDisabled()) {
    return {
      stop: () => undefined,
      runOnce: async () => ({ runs: 0, events: 0, signals: 0 }),
    };
  }

  await runDurableVacuum(store, opts);

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const handle = setInterval(() => {
    void runDurableVacuum(store, opts);
  }, intervalMs);
  // Don't keep the process alive solely for the vacuum.
  if (typeof handle.unref === 'function') handle.unref();

  return {
    stop: () => clearInterval(handle),
    runOnce: () => runDurableVacuum(store, opts),
  };
}
