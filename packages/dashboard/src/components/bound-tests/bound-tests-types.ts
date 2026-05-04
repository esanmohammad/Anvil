// UI-side mirrors of the server-side bound-tests / bound-tests-audit types.
// Kept deliberately decoupled from the server exports so this tree can be
// bundled for the browser without pulling node:fs / node:crypto via the
// server module graph, and so the shape we render survives independent
// evolution of the server record format.

export type BoundSeverity = 'info' | 'warning' | 'block';

export interface BoundRecord {
  /** Repo-relative path of the test file. */
  filePath: string;
  incidentId: string;
  replayId: string;
  /** ISO timestamp when the test was bound. */
  addedAt: string;
  /** Optional — most recent verify run (ISO timestamp). */
  lastVerifiedAt?: string;
  /** Optional — severity tier surfaced in the registry table. */
  severity?: BoundSeverity;
}

export type BoundAuditEvent =
  | 'bound'
  | 'overridden'
  | 'verified'
  | 'verify-failed';

export interface BoundAuditEntry {
  id: string;
  project: string;
  filePath: string;
  incidentId?: string;
  event: BoundAuditEvent;
  actor: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface VerifyResult {
  filePath: string;
  passed: boolean;
  /** Raw stdout / stderr captured from the verify run. */
  output: string;
  /** ISO timestamp. */
  at: string;
}
