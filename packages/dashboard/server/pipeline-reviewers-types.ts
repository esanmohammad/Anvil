/**
 * Types for Anvil's team-mode reviewer routing, approval tracking, and audit
 * logging — Phase 7 of the confidence-gated pipeline.
 *
 * When a pause is created, we assign a set of reviewers (derived from
 * CODEOWNERS + project groups). Approvals are tracked as a growing list on
 * the ReviewerAssignment record. Quorum is met when `approvalsRequired`
 * distinct users have approved and no user has rejected.
 *
 * Every transition is mirrored into an append-only audit log of AuditEntry
 * records so operators can reconstruct the history of a paused run (who
 * paused it, who approved/rejected, who reassigned, when the sweeper fired).
 */

export interface ReviewerGroup {
  /** Group tag as it appears in CODEOWNERS, e.g. '@security-team'. */
  tag: string;
  /** Resolved `@username` members of the group. */
  users: string[];
}

export interface ReviewerApproval {
  user: string;
  action: 'approve' | 'reject';
  /** ISO timestamp. */
  at: string;
  note?: string;
}

export interface ReviewerAssignment {
  runId: string;
  project: string;
  /** Resolved user list (groups already expanded). */
  reviewers: string[];
  /** N-of-M — quorum threshold. */
  approvalsRequired: number;
  approvals: ReviewerApproval[];
  /** ISO timestamp when the assignment was created. */
  createdAt: string;
}

export type AuditEvent =
  | 'paused'
  | 'approved'
  | 'rejected'
  | 'modified'
  | 'reassigned'
  | 'escalated'
  | 'timed-out';

export interface AuditEntry {
  /** Unique id (ULID-ish short random). */
  id: string;
  runId: string;
  project: string;
  event: AuditEvent;
  /** Username or 'system' (for sweeper / automated escalations). */
  actor: string;
  /** ISO timestamp. */
  at: string;
  details?: Record<string, unknown>;
}

export interface CodeownersRule {
  /** Raw glob pattern copied from CODEOWNERS (leading/trailing marks preserved). */
  pattern: string;
  /** `@users` and `@teams` that own matching paths. */
  owners: string[];
}
