/**
 * Skip-set reconciliation (FO1-1b).
 *
 * On resume there are TWO independent sources that decide which steps
 * to skip:
 *   1. the DISK path — `completedSteps` (a.k.a. priorCompleted), derived
 *      from the on-disk checkpoint / runs-index by the dashboard's
 *      resume handler, and
 *   2. the DURABLE path — every step with a `step:completed` event in
 *      the durable log (read in `Pipeline.run`), marked
 *      `replay-completed`.
 *
 * Before Fix A's finding-7 fix the dashboard resume minted a fresh
 * runId, so source 2 was always empty and the two could not disagree.
 * Now that resume reuses the ORIGINAL runId, both fire for the same
 * steps — normally an exact match. A mismatch is a real signal:
 *   - `onlyDisk`: the checkpoint says a step finished but the durable
 *     log has no `step:completed` for it. The durable log wins (it is
 *     the replay source of truth), so that step RE-RUNS — and its disk
 *     artifact may then be overwritten. Most likely cause: a crash
 *     between the durable write and the disk flush, or a stale runs
 *     index.
 *   - `onlyDurable`: the durable log completed a step the checkpoint
 *     never recorded. Usually harmless (durable is ahead), but worth
 *     surfacing — e.g. a manual `feature.json` delete leaving the
 *     durable row behind.
 *
 * This module does NOT change the resolution (durable still wins, which
 * is the pre-existing behaviour). It only makes the disagreement
 * computable + loggable so it stops being silent. Resolution beyond
 * "durable wins + warn loudly" needs replay-equivalence validation and
 * is deliberately out of scope here.
 */

export interface SkipSetDivergence {
  /** Steps the disk set marks completed that the durable log does not. */
  onlyDisk: string[];
  /** Steps the durable log marks completed that the disk set does not. */
  onlyDurable: string[];
}

/**
 * Symmetric difference between the disk-completed and durable-completed
 * step sets. Both outputs are sorted for stable logging / assertions.
 * Pure — no side effects.
 */
export function computeSkipSetDivergence(
  diskCompleted: Iterable<string>,
  durableCompleted: Iterable<string>,
): SkipSetDivergence {
  const disk = new Set(diskCompleted);
  const durable = new Set(durableCompleted);
  const onlyDisk = [...disk].filter((id) => !durable.has(id)).sort();
  const onlyDurable = [...durable].filter((id) => !disk.has(id)).sort();
  return { onlyDisk, onlyDurable };
}

/** True when the two skip sets disagree in either direction. */
export function hasSkipSetDivergence(d: SkipSetDivergence): boolean {
  return d.onlyDisk.length > 0 || d.onlyDurable.length > 0;
}

/** One-line human/forensic summary of a divergence. */
export function formatSkipSetDivergence(runId: string, d: SkipSetDivergence): string {
  return (
    `[durable] ${runId} resume skip-set divergence: ` +
    `disk-only=[${d.onlyDisk.join(',')}] durable-only=[${d.onlyDurable.join(',')}] ` +
    `— durable log wins (replay source of truth).`
  );
}
