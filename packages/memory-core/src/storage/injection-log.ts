/**
 * Memory-injection telemetry (Wave 4 of MEMORY-IMPACT-ON-FUTURE-RUNS-PLAN).
 *
 * Records which memories were injected into a (run, stage) prompt and
 * (post-run) marks the ones the agent actually used. The hit/miss ratio
 * per kind/subtype is the only data-driven knob we have for tuning
 * retrieval — without it every "tweak retrieval weights" decision is
 * gut-feel.
 *
 * Storage: `memory_injection` table in the same SQLite hot index that
 * holds memory rows. Schema in `schema.ts`. Bulk insert via prepared-
 * statement transaction so a stage warmup with 13 memories is one
 * SQLite write, not 13.
 *
 * Hit detection is the caller's job (`dashboard/server/pipeline/post-run.ts`
 * scans agent outputs). This module only owns the bookkeeping.
 */

import type Database from 'better-sqlite3';

export interface InjectionRecord {
  runId: string;
  stage: string;
  memoryId: string;
  injectedAt: string;
  used: boolean;
}

export interface HitStats {
  /** Memory kind (e.g., `semantic`) — null when subtype groups across kinds. */
  kind: string | null;
  /** Subtype within the kind (`fix-pattern`, `success`, …). */
  subtype: string | null;
  injected: number;
  used: number;
  /** `used / injected`, 0 when no injections. */
  hitRatio: number;
}

export class InjectionLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record a batch of injections for a (run, stage). Idempotent —
   * re-recording the same (run, stage, memoryId) tuple is a no-op.
   * Bulk transaction; one SQLite write per call regardless of N.
   */
  record(runId: string, stage: string, memoryIds: string[], at: string = new Date().toISOString()): void {
    if (memoryIds.length === 0) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memory_injection (run_id, stage, memory_id, injected_at, used)
      VALUES (?, ?, ?, ?, 0)
    `);
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) insert.run(runId, stage, id, at);
    });
    tx(memoryIds);
  }

  /**
   * Mark a specific memory as used by a run. Sets `used = 1` on every
   * (stage, memory) row for that run that matches. Returns the number
   * of rows touched — 0 means the memory wasn't in the injection log
   * for that run.
   */
  markUsed(runId: string, memoryId: string): number {
    const result = this.db
      .prepare(`UPDATE memory_injection SET used = 1 WHERE run_id = ? AND memory_id = ?`)
      .run(runId, memoryId);
    return result.changes;
  }

  /**
   * Read back the injection log for one run. Includes both used + unused
   * entries; consumers filter as needed.
   */
  forRun(runId: string): InjectionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM memory_injection WHERE run_id = ? ORDER BY stage, injected_at`)
      .all(runId) as Array<{
        run_id: string;
        stage: string;
        memory_id: string;
        injected_at: string;
        used: number;
      }>;
    return rows.map((r) => ({
      runId: r.run_id,
      stage: r.stage,
      memoryId: r.memory_id,
      injectedAt: r.injected_at,
      used: r.used !== 0,
    }));
  }

  /**
   * Memory ids referenced by a specific (run, stage). Used by hit
   * detection to know which memories to scan output against.
   */
  injectedFor(runId: string, stage: string): string[] {
    const rows = this.db
      .prepare(`SELECT memory_id FROM memory_injection WHERE run_id = ? AND stage = ?`)
      .all(runId, stage) as Array<{ memory_id: string }>;
    return rows.map((r) => r.memory_id);
  }

  /**
   * Aggregate hit/miss stats per kind+subtype across all runs in the
   * window. JOINs against the memory table to recover kind/subtype from
   * the injection's memory_id. Memories deleted post-injection still
   * appear with `kind=null` (rare; only after a hard-delete sweep).
   */
  hitStatsByKind(opts: { sinceIso?: string } = {}): HitStats[] {
    const sinceIso = opts.sinceIso ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = this.db
      .prepare(`
        SELECT
          m.kind AS kind,
          m.subtype AS subtype,
          COUNT(*) AS injected,
          SUM(mi.used) AS used
        FROM memory_injection mi
        LEFT JOIN memory m ON m.id = mi.memory_id
        WHERE mi.injected_at >= ?
        GROUP BY m.kind, m.subtype
        ORDER BY injected DESC
      `)
      .all(sinceIso) as Array<{ kind: string | null; subtype: string | null; injected: number; used: number | null }>;
    return rows.map((r) => {
      const injected = r.injected;
      const used = r.used ?? 0;
      return {
        kind: r.kind,
        subtype: r.subtype,
        injected,
        used,
        hitRatio: injected === 0 ? 0 : used / injected,
      };
    });
  }

  /**
   * Per-memory hit count — useful for the inspector to surface high-
   * value (hit-heavy) memories. Returns the top-N most-hit memories
   * across the window.
   */
  topHitMemories(opts: { limit?: number; sinceIso?: string } = {}): Array<{
    memoryId: string;
    used: number;
    injected: number;
  }> {
    const limit = opts.limit ?? 20;
    const sinceIso = opts.sinceIso ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    return this.db
      .prepare(`
        SELECT
          memory_id AS memoryId,
          SUM(used) AS used,
          COUNT(*) AS injected
        FROM memory_injection
        WHERE injected_at >= ?
        GROUP BY memory_id
        ORDER BY used DESC, injected DESC
        LIMIT ?
      `)
      .all(sinceIso, limit) as Array<{ memoryId: string; used: number; injected: number }>;
  }

  /**
   * Drop injection records older than the cutoff. Bounded retention
   * keeps the table cheap to scan. Called from sleeptime's daily
   * vacuum pass. Default 90 days.
   */
  vacuumOlderThan(cutoffIso: string): number {
    const result = this.db
      .prepare(`DELETE FROM memory_injection WHERE injected_at < ?`)
      .run(cutoffIso);
    return result.changes;
  }
}
