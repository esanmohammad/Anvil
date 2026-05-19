/**
 * Pattern-1 → Pattern-2 migration runner + Phase F4 multi-process
 * auto-takeover.
 *
 * Two responsibilities at dashboard startup:
 *
 *   1. **Pattern-1 sweep.** Scans `~/.anvil/runs/` for directories
 *      that look like in-flight runs (audit log present, no
 *      terminal `pipeline:completed` / `pipeline:failed` event).
 *      Any such run that doesn't yet have a row in the durable
 *      `runs` table is inserted with `status: 'failed'` + the
 *      Pattern-1 marker.
 *
 *   2. **Orphan takeover.** Any run already in the durable table
 *      with `status='running'` and an expired lease belongs to a
 *      crashed peer. By default the dashboard now takes over —
 *      acquires the lease + leaves the row in `running` so a
 *      caller (auto-replay queue, user click) can replay it via
 *      Pipeline.run() with the same runId. Set
 *      `ANVIL_DURABLE_AUTO_TAKEOVER=0` to revert to the v1
 *      "mark failed" behaviour.
 *
 * No artifact is touched. The audit log + state file remain in
 * place for forensic + Pattern-1-fallback consumption.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  findOrphanedRuns,
  tryTakeOverLease,
  type DurableStore,
} from '@esankhan3/anvil-core-pipeline';
import { durableHolderId } from './durable-store-singleton.js';

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
  /** Phase F4: orphaned runs whose lease this process took over. */
  takenOver: number;
  /**
   * Phase F4: orphaned runs that this process tried to take over but
   * couldn't (a peer raced + won) — these stay 'running' under the
   * peer's ownership.
   */
  takeoverContested: number;
}

/** Phase F4: caller-supplied resume hook. Receives runIds the dashboard took over. */
export type TakeoverHook = (runIds: string[]) => void;

function anvilRunsDir(): string {
  const env = process.env.ANVIL_HOME;
  return join(env ?? join(homedir(), '.anvil'), 'runs');
}

export async function runDurableMigration(
  store: DurableStore | null,
  opts: { onTakeover?: TakeoverHook } = {},
): Promise<MigrationStats> {
  const stats: MigrationStats = {
    scanned: 0, migrated: 0, errors: 0,
    orphaned: 0, takenOver: 0, takeoverContested: 0,
  };
  if (!store) return stats;

  // Phase F4: orphaned-run sweep with auto-takeover. Any run with
  // status='running' whose lease has expired belongs to a crashed
  // peer. Default behaviour: take the lease over so the caller can
  // resume via Pipeline.run() with the recorded cursor. Override
  // by setting ANVIL_DURABLE_AUTO_TAKEOVER=0 to keep the v1 "mark
  // failed" semantics.
  const autoTakeover = process.env.ANVIL_DURABLE_AUTO_TAKEOVER !== '0';
  const holder = durableHolderId();
  const takenOverIds: string[] = [];
  try {
    const orphans = await findOrphanedRuns(store);
    for (const runId of orphans) {
      stats.orphaned += 1;
      if (!autoTakeover) {
        try {
          await store.updateRunStatus(runId, 'failed');
          await store.appendEvent({
            runId,
            kind: 'cancel:requested',
            payload: { reason: 'orphaned-lease-on-startup' },
          });
        } catch {
          /* skip individual failure */
        }
        continue;
      }
      try {
        const won = await tryTakeOverLease(store, runId, holder, 60_000);
        if (won) {
          await store.appendEvent({
            runId,
            kind: 'run:status',
            payload: { reason: 'orphan-takeover', holder },
          });
          stats.takenOver += 1;
          takenOverIds.push(runId);
        } else {
          stats.takeoverContested += 1;
        }
      } catch {
        /* skip individual failure */
      }
    }
  } catch {
    /* best-effort */
  }
  if (takenOverIds.length > 0 && opts.onTakeover) {
    try {
      opts.onTakeover(takenOverIds);
    } catch (err) {
      console.warn(`[durable-migration] onTakeover hook threw: ${err instanceof Error ? err.message : err}`);
    }
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
