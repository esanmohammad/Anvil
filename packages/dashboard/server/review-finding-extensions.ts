/**
 * Extension fields for ReviewFinding used by the R2 evidence gate and later
 * calibration phases. Kept in a separate module so review-store.ts stays stable.
 */

import type { ReviewFinding } from './review-store.js';

export type ClaimType =
  | 'null-deref'
  | 'type-mismatch'
  | 'unusual-pattern'
  | 'missing-test'
  | 'assumption'
  | 'security'
  | 'performance'
  | 'other';

export interface EvidenceCheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ExtendedFindingFields {
  /** What kind of claim this finding is making. Drives which checks apply. */
  claimType?: ClaimType;
  /** Verbatim text from the diff backing the claim. */
  quoted?: string;
  /** Symbol the claim is about, e.g. "user.email" or "fooBar". */
  targetSymbol?: string;
  /** Expected TypeScript/language type for a type-mismatch claim. */
  expectedType?: string;
  /** Precondition the code supposedly assumes, e.g. "input is non-null". */
  assumedPrecondition?: string;
  /** Results of each evidence check that was run against this finding. */
  evidenceChecks?: EvidenceCheckResult[];
  /** True if calibration or user dismissal demoted this finding. */
  demoted?: boolean;
  /** Blockers that cannot be dismissed by the user. */
  immutable?: boolean;
  /** Unified diff for one-click apply. */
  proposedPatch?: string;
  /** Persona-stated confidence, 0..1. */
  statedConfidence?: number;
  /** Calibrated confidence, filled by a later phase. */
  calibratedConfidence?: number;
}

export type EnrichedFinding = ReviewFinding & ExtendedFindingFields;

/** Append an evidence check result to a finding, creating the array if needed. */
export function appendEvidenceCheck(
  finding: EnrichedFinding,
  result: EvidenceCheckResult,
): EnrichedFinding {
  const list = finding.evidenceChecks ? [...finding.evidenceChecks] : [];
  list.push(result);
  return { ...finding, evidenceChecks: list };
}

/** True if any check has explicitly failed (not skipped). */
export function hasFailedCheck(finding: EnrichedFinding): boolean {
  return (finding.evidenceChecks ?? []).some((c) => c.passed === false);
}

/** Normalize whitespace for fuzzy equality (collapse runs, trim). */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
