/**
 * `DurableStore` — the persistence interface that backs durable
 * execution. SQLite is the v1 default driver; in-memory backs tests;
 * Postgres is reserved for v2 (single-machine SQLite is
 * sufficient for v1).
 *
 * The interface is deliberately small. Effect lookup, replay, and
 * lease arbitration are implemented in terms of `appendEvent`,
 * `readEvents`, `readEffectEvents`, and `acquireLease` — drivers
 * don't make policy decisions, they just persist + retrieve.
 */

import type {
  EffectEventPair,
  EventRecord,
  NewEventRecord,
  NewRunRecord,
  RunRecord,
  RunStatus,
  SignalRecord,
} from './types.js';

export interface VacuumStats {
  runs: number;
  events: number;
  signals: number;
}

export interface DurableStore {
  // ── Run lifecycle ────────────────────────────────────────────────
  createRun(run: NewRunRecord): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  updateRunStatus(runId: string, status: RunStatus, currentStep?: string | null): Promise<void>;
  /** Updates the cursor (last-replayed seq) — used during replay. */
  updateRunCursor(runId: string, cursorSeq: number): Promise<void>;
  listRunsByStatus(status: RunStatus): Promise<RunRecord[]>;

  // ── Lease ────────────────────────────────────────────────────────
  /** Returns true if the lease was acquired. False if held by a live peer. */
  acquireLease(runId: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Renews an existing lease. Returns false if `holder` no longer owns it. */
  renewLease(runId: string, holder: string, ttlMs: number): Promise<boolean>;
  releaseLease(runId: string, holder: string): Promise<void>;

  // ── Events ───────────────────────────────────────────────────────
  appendEvent(event: NewEventRecord): Promise<EventRecord>;
  /** Atomic batch append — used when emitting multiple events under one transaction. */
  appendBatch(events: NewEventRecord[]): Promise<EventRecord[]>;
  readEvents(runId: string, fromSeq?: number): Promise<EventRecord[]>;
  /** Returns started/completed event pairs for every effect call within a step. */
  readEffectEvents(runId: string, stepId: string): Promise<EffectEventPair[]>;

  // ── Signals ──────────────────────────────────────────────────────
  enqueueSignal(runId: string, channel: string, payload: unknown): Promise<void>;
  /** Returns the oldest unconsumed signal payload on the channel; marks it consumed. */
  consumeSignal(runId: string, channel: string): Promise<unknown | null>;
  /** Read-only — returns all signals (consumed + unconsumed) for tests / observability. */
  readSignals(runId: string, channel?: string): Promise<SignalRecord[]>;

  // ── Maintenance ──────────────────────────────────────────────────
  vacuum(olderThanIso: string): Promise<VacuumStats>;
  /** Closes any underlying handle (file descriptor, connection pool). */
  close(): Promise<void>;
}
