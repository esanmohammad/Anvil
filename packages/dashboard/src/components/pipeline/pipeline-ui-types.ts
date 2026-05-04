// Client-side mirror of server pipeline pause/resume types. Kept in a
// dedicated module so UI components stay decoupled from server internals.

export type PauseStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';
export type PauseStatus = 'paused-awaiting-user' | 'resumed' | 'cancelled' | 'timed-out';
export type RiskTier = 'low' | 'med' | 'high';

export interface RiskFactor {
  key: string;
  label: string;
  weight: number;
  detail?: string;
}

export interface RiskScore {
  overall: number;
  tier: RiskTier;
  factors: RiskFactor[];
  confidence: number;
  scopeBoundaryRisks: string[];
}

export interface PauseState {
  runId: string;
  project: string;
  stage: PauseStage;
  reason: string;
  matchedRules: string[];
  reviewers: string[];
  pausedAt: string;
  timeoutAt?: string;
  status: PauseStatus;
}

export interface TokenCostEstimate {
  usd: number;
  inTokens: number;
  outTokens: number;
}

export interface PausedRunData {
  pause: PauseState;
  riskScore?: RiskScore;
  planSummary?: string;
  touchedFiles?: string[];
  predictedDiff?: string;
  tokenCostEstimate?: TokenCostEstimate;
}

/**
 * Canonical action set for resolving a paused pipeline run. Matches
 * `pipeline-pause-handlers.ts:isValidAction` server-side — keep them in
 * sync.
 *
 *   approve            — proceed as-is.
 *   approve-with-note  — proceed but inject `note` into the NEXT stage's
 *                        user prompt.
 *   modify-artifact    — server replaces the paused stage's artifact text
 *                        with `editedArtifact` before the next stage runs.
 *   iterate-with-note  — re-run the JUST-paused stage with `note` injected
 *                        as feedback (engineer/analyst/etc. refines their
 *                        own output). Working-tree state preserved.
 *   rerun-from         — discard work from `rerunFromStage` onwards and
 *                        replay; `note` is injected as failure context.
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
  /** Replacement markdown for the just-paused stage's artifact (modify-artifact only). */
  editedArtifact?: string;
  /** Stage index to roll back to; intermediate stages are marked pending and replayed. */
  rerunFromStage?: number;
}
