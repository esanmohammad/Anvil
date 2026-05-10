/**
 * Durable execution record types.
 *
 * Core types shared between every `DurableStore` driver (SQLite,
 * in-memory, future Postgres). The schema mirrors §G of
 * `docs/durable-execution-plan.md` (runs / events / signals).
 *
 * Three append-only-ish concepts:
 *   - `RunRecord` — long-lived row per workflow execution. The only
 *     fields that mutate in place are `status`, `currentStep`,
 *     `cursorSeq`, `updatedAt`, and the lease columns.
 *   - `EventRecord` — strict append. Every step boundary +
 *     every effect call lives here. `seq` is monotonically
 *     increasing within a run.
 *   - `SignalRecord` — out-of-band insertions from outside the
 *     workflow (reviewer decisions, Q&A answers). Consumed in
 *     arrival order; consumed rows have `consumed=1`.
 */

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

/**
 * Status taxonomy for a durable run. Pre-running states are
 * `pending`. Active execution is `running`. `paused` covers
 * reviewer / Q&A waits where the workflow has yielded but is still
 * owned by a process. Terminal states: `completed`, `failed`,
 * `cancelled`. `compensating` is the special state during reverse
 * walk after a non-success terminal status.
 */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'compensating';

export interface NewRunRecord {
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  workflowVer?: number;
}

export interface RunRecord {
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: RunStatus;
  currentStep: string | null;
  cursorSeq: number;
  startedAt: string;
  updatedAt: string;
  leaseHolder: string | null;
  leaseExpires: string | null;
  workflowVer: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Event kinds the durable log understands. Mirrors the canonical
 * pipeline lifecycle plus durable-specific markers (effect lifecycle,
 * signal receipt, reviewer decisions, rewind markers,
 * cancellation, compensation, version bumps).
 */
export type DurableEventKind =
  | 'run:created'
  | 'run:status'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:skipped'
  | 'effect:started'
  | 'effect:completed'
  | 'effect:failed'
  | 'signal:received'
  | 'reviewer:decision'
  | 'rewindTo:set'
  | 'cancel:requested'
  | 'compensate:effect:started'
  | 'compensate:effect:completed'
  | 'compensate:effect:failed';

export interface NewEventRecord {
  runId: string;
  kind: DurableEventKind;
  stepId?: string | null;
  effectKey?: string | null;
  effectIdx?: number | null;
  payload: unknown;
  ts?: string;
}

export interface EventRecord {
  runId: string;
  seq: number;
  kind: DurableEventKind;
  stepId: string | null;
  effectKey: string | null;
  effectIdx: number | null;
  payload: unknown;
  ts: string;
}

/**
 * Pair of (started, completed?) effect events for a single
 * (step_id, effect_key, effect_idx) tuple. Used by replay logic to
 * decide whether an effect has been observed before — `completed`
 * undefined means the process crashed mid-effect and the effect
 * MUST re-run on resume.
 */
export interface EffectEventPair {
  started: EventRecord;
  completed?: EventRecord;
  failed?: EventRecord;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export interface SignalRecord {
  runId: string;
  channel: string;
  payload: unknown;
  ts: string;
  consumed: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the engine when replay diverges — an effect call's
 * name or input hash differs from what was recorded. The user
 * resolves by re-running from the affected stage; the run is
 * dead in its current shape.
 */
export class DeterminismViolationError extends Error {
  constructor(
    public readonly runId: string,
    public readonly stepId: string,
    public readonly reason:
      | 'effect-name-mismatch'
      | 'effect-input-hash-mismatch'
      | 'version-mismatch'
      | 'effect-idx-mismatch',
    detail: string,
  ) {
    super(`DeterminismViolationError [run=${runId} step=${stepId} reason=${reason}]: ${detail}`);
    this.name = 'DeterminismViolationError';
  }
}

/** Thrown when the durable store is unreachable (disk full, file lock, etc.). */
export class DurableStoreUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DurableStoreUnavailableError';
  }
}

/** Thrown when an effect's return value cannot be JSON-serialised. */
export class EffectResultNotSerialisableError extends Error {
  constructor(public readonly effectKey: string, public readonly cause: unknown) {
    super(`Effect "${effectKey}" returned a value that is not JSON-serialisable: ${String(cause)}`);
    this.name = 'EffectResultNotSerialisableError';
  }
}

/** Thrown when migration finds a Pattern-1 in-flight run. Surfaced to user. */
export class Pattern1MigrationError extends Error {
  constructor(public readonly runId: string) {
    super(`Run "${runId}" was started before durable execution shipped; please re-run from the failed stage.`);
    this.name = 'Pattern1MigrationError';
  }
}
