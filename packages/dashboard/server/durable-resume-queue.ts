/**
 * Auto-resume queue (Phase G1).
 *
 * After F4's `runDurableMigration` claims orphaned-lease runs via
 * `tryTakeOverLease`, this queue actually replays them: for each
 * reclaimed runId we look up the durable RunRecord, derive the
 * resume-from-stage from the cursor + the events log, and dispatch
 * to the caller-supplied `startPipeline` (which reuses the same
 * code path as a fresh user-initiated run).
 *
 * The dashboard supports one active pipeline at a time
 * (`startPipeline` cancels the active runner), so reclaimed runs
 * are replayed serially with `await` between dispatches. Caller
 * controls the dispatch loop — typically called once after the
 * dashboard finishes booting all dependencies.
 *
 * If the queue is enabled (`ANVIL_DURABLE_AUTO_RESUME` !== '0') it
 * fires automatically; explicit opt-out keeps the F4 behaviour of
 * "claim the lease but wait for user click to replay."
 */

import type { DurableStore, EventRecord } from '@esankhan3/anvil-core-pipeline';

/** Caller-supplied start hook — same shape as dashboard-server's startPipeline. */
export type StartPipelineFn = (
  project: string,
  feature: string,
  options?: {
    resumeFromStage?: number;
    featureSlug?: string;
  },
) => void | Promise<void>;

export interface AutoResumeOptions {
  /** Override env-var disable. */
  disabled?: boolean;
  /** Receives a log line per dispatch. */
  onLog?: (line: string) => void;
  /** Wait between dispatches to let runner.run() get past the bootstrap. */
  delayBetweenMs?: number;
}

export interface AutoResumeStats {
  attempted: number;
  dispatched: number;
  skipped: number;
  errors: number;
}

const DEFAULT_DELAY_MS = 1500;

/**
 * Read the latest `step:started` event without a matching
 * `step:completed` to figure out which stage to resume from.
 * Falls back to stage 0 if nothing is in flight.
 *
 * Stages here are matched by stepId — the dashboard's STAGES
 * registry is the source of truth for the index map.
 */
function deriveResumeStageFromEvents(
  events: EventRecord[],
  stagesByName: Record<string, number>,
): { resumeFromStage: number; lastStepId: string | null } {
  let lastStepId: string | null = null;
  const startedNotCompleted = new Set<string>();
  for (const ev of events) {
    if (ev.kind === 'step:started' && ev.stepId) {
      startedNotCompleted.add(ev.stepId);
      lastStepId = ev.stepId;
    } else if ((ev.kind === 'step:completed' || ev.kind === 'step:failed') && ev.stepId) {
      startedNotCompleted.delete(ev.stepId);
    }
  }
  // Resume from the FIRST started-but-not-completed step. If none,
  // resume from after the last completed step.
  for (const id of startedNotCompleted) {
    if (id in stagesByName) return { resumeFromStage: stagesByName[id], lastStepId };
  }
  // No in-flight step → resume after the last step recorded.
  if (lastStepId && lastStepId in stagesByName) {
    // +1 = run the next one. Caller can clamp on out-of-range.
    return { resumeFromStage: Math.min(stagesByName[lastStepId] + 1, Object.keys(stagesByName).length - 1), lastStepId };
  }
  return { resumeFromStage: 0, lastStepId: null };
}

export async function dispatchTakenOverRuns(
  store: DurableStore | null,
  runIds: ReadonlyArray<string>,
  startPipeline: StartPipelineFn,
  stagesByName: Record<string, number>,
  opts: AutoResumeOptions = {},
): Promise<AutoResumeStats> {
  const stats: AutoResumeStats = { attempted: 0, dispatched: 0, skipped: 0, errors: 0 };
  const disabled = opts.disabled ?? process.env.ANVIL_DURABLE_AUTO_RESUME === '0';
  if (disabled || !store || runIds.length === 0) return stats;

  const log = opts.onLog ?? ((s: string) => console.log(s));
  const delay = opts.delayBetweenMs ?? DEFAULT_DELAY_MS;

  for (const runId of runIds) {
    stats.attempted += 1;
    try {
      const run = await store.getRun(runId);
      if (!run) {
        stats.skipped += 1;
        continue;
      }
      // Refuse to replay a run whose project + feature placeholders
      // came from the Pattern-1 migration (recorded as 'unknown').
      // The user must manually rerun those.
      if (run.project === 'unknown' || run.feature === 'unknown') {
        log(`[auto-resume] ${runId}: skipping — Pattern-1 migration row, project/feature unknown`);
        stats.skipped += 1;
        continue;
      }

      const events = await store.readEvents(runId);
      const { resumeFromStage, lastStepId } = deriveResumeStageFromEvents(events, stagesByName);
      log(
        `[auto-resume] ${runId}: dispatching ${run.project}/${run.feature} `
          + `(resumeFromStage=${resumeFromStage}, lastStepId=${lastStepId ?? '<none>'})`,
      );
      await startPipeline(run.project, run.feature, {
        resumeFromStage,
        featureSlug: run.featureSlug,
      });
      stats.dispatched += 1;
      // Serial dispatch — wait for the runner to claim the active slot.
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      stats.errors += 1;
      log(`[auto-resume] ${runId} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return stats;
}
