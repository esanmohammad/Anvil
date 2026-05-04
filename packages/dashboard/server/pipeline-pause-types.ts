/**
 * Types for Anvil's pipeline pause/resume primitives — Phase 3 of the
 * confidence-gated pipeline.
 *
 * When policy decides a stage must pause, a PauseState record is created and
 * persisted. Reviewers resume it via a ResumeDecision. A sweeper advances
 * stale pauses to 'timed-out'.
 */

export type PauseStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';

export type PauseStatus =
  | 'paused-awaiting-user'
  | 'resumed'
  | 'cancelled'
  | 'timed-out';

/**
 * Canonical resume actions. Mirrored client-side in
 * `dashboard/src/components/pipeline/pipeline-ui-types.ts`.
 *
 *   approve            — proceed as-is.
 *   approve-with-note  — proceed but inject `note` into the NEXT stage's prompt.
 *   modify-artifact    — replace the paused stage's artifact with
 *                        `editedArtifact` before the next stage runs.
 *   iterate-with-note  — re-run the JUST-paused stage with `note` injected
 *                        as feedback. Working tree is preserved; only the
 *                        stage's status/artifact/cost reset. Use this when
 *                        the work is mostly right but needs refinement
 *                        (e.g., engineer should "also do X").
 *   rerun-from         — discard work from `rerunFromStage` onwards and
 *                        replay; `note` is injected as retry framing
 *                        (failureContext). Use this when the scope of the
 *                        problem is multiple stages back.
 *   cancel             — kill the run.
 */
export type ResumeAction =
  | 'approve'
  | 'approve-with-note'
  | 'modify-artifact'
  | 'iterate-with-note'
  | 'rerun-from'
  | 'cancel';

export interface ResumeDecision {
  action: ResumeAction;
  /** Free-text feedback. Required for approve-with-note, iterate-with-note, rerun-from. */
  note?: string;
  /** Replacement markdown body for the just-paused stage's artifact. */
  editedArtifact?: string;
  /** Stage index to roll back to; intermediate stages are marked pending and replayed. */
  rerunFromStage?: number;
}

export interface PauseState {
  runId: string;
  project: string;
  stage: PauseStage;
  /** Free-form reason shown in UI (usually carried from PolicyDecision.reason). */
  reason: string;
  /** Rule identifiers / globs from the policy evaluation that caused the pause. */
  matchedRules: string[];
  /** Usernames or group tags expected to approve. */
  reviewers: string[];
  /** ISO timestamp when the pause was recorded. */
  pausedAt: string;
  /** ISO timestamp at which the sweeper will fire, if any. */
  timeoutAt?: string;
  status: PauseStatus;
  resumeDecision?: ResumeDecision;
  /** ISO timestamp of resume/cancel/timeout transition. */
  resumedAt?: string;
  /** Username or 'system' (for sweeper). */
  resumedBy?: string;
}

export interface PauseQueryFilters {
  project?: string;
  status?: PauseStatus;
  stage?: PauseStage;
}

/** Lightweight record stored in the global index.json. */
export interface PausePointer {
  runId: string;
  project: string;
  status: PauseStatus;
  pausedAt: string;
}
