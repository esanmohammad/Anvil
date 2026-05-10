/**
 * Pattern-1 → Pattern-2 migration runner.
 *
 * Invoked once at dashboard startup. Scans `~/.anvil/runs/` for
 * directories that look like in-flight runs (audit log present, no
 * terminal `pipeline:completed` / `pipeline:failed` event). Any such
 * run that doesn't yet have a row in the durable `runs` table is
 * inserted with `status: 'failed'` and a marker payload — the user
 * sees a one-line "this run was started before durable execution
 * shipped; please rerun from the failed stage" message in the
 * history panel.
 *
 * No artifact is touched. The audit log + state file remain in place
 * for forensic + Pattern-1-fallback consumption.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { findOrphanedRuns, type DurableStore } from '@esankhan3/anvil-core-pipeline';

interface AuditEntry {
  hook: string;
  runId?: string;
  ts?: string;
  payload?: Record<string, unknown>;
  stepId?: string;
}

export interface MigrationStats {
  scanned: number;
  migrated: number;
  errors: number;
  /** Phase D6: durable runs marked `running` whose lease has expired. */
  orphaned: number;
}

function anvilRunsDir(): string {
  const env = process.env.ANVIL_HOME;
  return join(env ?? join(homedir(), '.anvil'), 'runs');
}

export async function runDurableMigration(store: DurableStore | null): Promise<MigrationStats> {
  const stats: MigrationStats = { scanned: 0, migrated: 0, errors: 0, orphaned: 0 };
  if (!store) return stats;

  // Phase D6: orphaned-run sweep. Any run with status='running' whose
  // lease has expired belongs to a process that crashed. Mark it
  // 'failed' so the user sees it in the run history; durable replay
  // means a follow-up `anvil resume <runId>` can pick it up.
  try {
    const orphans = await findOrphanedRuns(store);
    for (const runId of orphans) {
      try {
        await store.updateRunStatus(runId, 'failed');
        await store.appendEvent({
          runId,
          kind: 'cancel:requested',
          payload: { reason: 'orphaned-lease-on-startup' },
        });
        stats.orphaned += 1;
      } catch {
        /* skip individual failure */
      }
    }
  } catch {
    /* best-effort */
  }

  const runsDir = anvilRunsDir();
  if (!existsSync(runsDir)) return stats;

  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return stats;
  }

  for (const runId of entries) {
    if (!runId.startsWith('run-')) continue;
    const runPath = join(runsDir, runId);
    try {
      const st = statSync(runPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    stats.scanned += 1;

    try {
      const auditPath = join(runPath, 'audit.jsonl');
      if (!existsSync(auditPath)) continue;
      const content = readFileSync(auditPath, 'utf8').trim();
      if (!content) continue;

      const lines = content.split('\n').slice(-200); // tail-only is enough
      let saw: AuditEntry | null = null;
      let terminal = false;
      let stepIdAtCrash: string | null = null;
      for (const ln of lines) {
        try {
          const e = JSON.parse(ln) as AuditEntry;
          if (e.hook === 'pipeline:completed' || e.hook === 'pipeline:failed') {
            terminal = true;
          }
          if (e.hook === 'step:started' && e.stepId) {
            stepIdAtCrash = e.stepId;
          }
          if (e.hook === 'step:completed') {
            stepIdAtCrash = null;
          }
          saw = e;
        } catch {
          // skip malformed line
        }
      }
      if (terminal || !saw) continue;

      const existing = await store.getRun(runId);
      if (existing) continue; // already known

      // Best-effort fields. Project + feature are not always in the
      // audit log payload; default to placeholders. The dashboard's
      // run history merges by runId so this row carries enough
      // signal to render "interrupted; rerun".
      await store.createRun({
        runId,
        project: 'unknown',
        feature: 'unknown',
        featureSlug: 'unknown',
      });
      await store.appendEvent({
        runId,
        kind: 'run:created',
        stepId: stepIdAtCrash,
        payload: { reason: 'migration-from-pattern-1' },
      });
      await store.updateRunStatus(runId, 'failed', stepIdAtCrash);
      stats.migrated += 1;
    } catch (err) {
      stats.errors += 1;
      console.warn(`[durable-migration] Failed for ${runId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return stats;
}
