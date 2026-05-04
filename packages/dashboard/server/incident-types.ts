/**
 * incident-types — shared type definitions for Anvil's bug-to-test replay feature.
 *
 * An IncidentRecord is the structured capture of a production bug (from
 * incident.io, Sentry, Datadog, Jira, Linear, or a manual entry). A
 * ReplayAttempt is the result of attempting to reproduce that incident via a
 * generated TestSpec behavior + test case, then re-running it against the
 * fix commit to confirm the fix is effective.
 *
 * The types here mirror the style of test-types.ts: versioned / timestamped
 * records, enum-like string unions, optional enrichment fields. Persistence
 * logic lives in `incident-store.ts` and `replay-store.ts`.
 */

// ── Enums ────────────────────────────────────────────────────────────────

export type IncidentSource = 'incident.io' | 'sentry' | 'datadog' | 'jira' | 'linear' | 'manual';
export type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4' | 'unknown';
export type ReplayStatus = 'pending' | 'reproducing' | 'confirmed' | 'unreproducible' | 'low-confidence';
export type ReplayConfidence = 'high' | 'med' | 'low';

// ── Incident ─────────────────────────────────────────────────────────────

export interface FailingSymbol {
  file: string;
  function: string;
  line: number;
}

export interface IncidentRecord {
  id: string;                         // incident-<base36>-<hex4>
  project: string;
  externalId: string;                 // Sentry event id, incident.io UUID, Jira key, etc.
  source: IncidentSource;
  url: string;
  title: string;
  severity: IncidentSeverity;
  occurredAt: string;
  resolvedAt?: string;
  summary: string;
  stackTrace?: string;
  failingSymbol?: FailingSymbol;
  requestPayload?: unknown;
  env?: Record<string, string>;
  fixCommit?: string;
  parentCommit?: string;
  linkedPrUrl?: string;
  affectedUsers?: number;
  capturedAt: string;
  tags?: string[];
}

export interface IncidentPointer {
  id: string;
  source: IncidentSource;
  externalId: string;
  title: string;
  severity: IncidentSeverity;
  occurredAt: string;
}

// ── Replay ───────────────────────────────────────────────────────────────

export interface ReplayStepResult {
  commit: string;
  pass: boolean;
  failure?: string;
  durationMs: number;
}

export interface ReplayAttempt {
  id: string;                         // replay-<base36>-<hex4>
  project: string;
  incidentId: string;
  specSlug: string;
  specVersion: number;
  behaviorId: string;
  caseId: string;
  status: ReplayStatus;
  preFixResult?: ReplayStepResult;
  postFixResult?: ReplayStepResult;
  confidence: ReplayConfidence;
  notes: string[];
  createdAt: string;
  completedAt?: string;
  boundTestFile?: string;             // repo-relative path
}
