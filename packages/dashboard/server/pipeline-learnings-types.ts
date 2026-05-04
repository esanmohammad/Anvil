/**
 * Phase 6 — learning-loop types for the confidence-gated pipeline.
 *
 * These types capture the *outcome* of a plan-gate decision (approve / modify /
 * reject / etc.) so that we can aggregate patterns across runs and feed them
 * back into the planner. Nothing in this file performs side effects — the
 * storage layer lives in {@link file://./pipeline-learnings-store.ts}.
 */

/** The terminal outcome of a gate decision for a single plan version. */
export type PlanOutcome =
  | 'approved'
  | 'modified'
  | 'rejected'
  | 'timed-out'
  | 'replanned';

/** A single decision record, persisted once per resolved plan gate. */
export interface PlanApprovalRecord {
  /** Unique record id (assigned by the store). */
  id: string;
  /** Project slug this decision belongs to. */
  project: string;
  /** Pipeline runId that produced the plan under review. */
  runId: string;
  /** Plan version (monotonic per run) the decision applies to. */
  planVersion: number;
  /** Terminal outcome of this gate. */
  outcome: PlanOutcome;
  /** Risk tier the plan was scored at when the user saw it. */
  riskTier?: 'low' | 'med' | 'high';
  /** Overall risk score in 0..1, if scored. */
  riskOverall?: number;
  /** Planner confidence in 0..1, if reported. */
  confidence?: number;
  /** Top-level dirs the plan intends to touch (e.g. ['src/auth', 'docs']). */
  touchedTopLevelDirs: string[];
  /** Optional description of what the user changed on approval-with-edits. */
  modifications?: {
    filesAdded: string[];
    filesRemoved: string[];
    notes?: string;
  };
  /** Free-text reason supplied when rejecting the plan. */
  rejectionReason?: string;
  /** Identity of the approver (email/login). */
  approvedBy?: string;
  /** ISO timestamp when the decision was recorded. */
  decidedAt: string;
  /** Time elapsed between the pause and the decision (ms). */
  decisionLatencyMs?: number;
}

/** Approval statistics aggregated per top-level path. */
export interface PathApprovalStats {
  path: string;
  total: number;
  approved: number;
  modified: number;
  rejected: number;
  approvalRate: number;
  avgDecisionLatencyMs: number;
}

/** Full roll-up returned by {@link PipelineLearningsStore.computeStats}. */
export interface PlanApprovalStats {
  projectSlug: string;
  totalPlans: number;
  approvalRate: number;
  modificationRate: number;
  rejectionRate: number;
  avgDecisionLatencyMs: number;
  byPath: PathApprovalStats[];
  byRiskTier: Record<'low' | 'med' | 'high', { total: number; approvalRate: number }>;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  updatedAt: string;
}
