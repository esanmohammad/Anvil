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
  AssistantPartialRecord,
  EffectEventPair,
  EventRecord,
  NewAssistantPartialRecord,
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

  // ── Assistant partials (v2 ADR §2.2 — turn-level durable resume) ──
  /** Persist a partial assistant turn flushed when a model burned
   *  mid-stream. Fire-and-forget from the adapter's perspective.
   *  Single-writer-per-turn contract: one adapter owns one
   *  (runId, stepId, turnUuid) at a time, so concurrent appends to the
   *  SAME tuple don't occur in practice. The SQLite driver still
   *  computes `seq` inside a transaction (race-safe); the in-memory
   *  driver assumes the single-writer contract (dev/test only). */
  appendAssistantPartial(partial: NewAssistantPartialRecord): Promise<AssistantPartialRecord>;
  /** Read non-invalidated partials for a turn (or — when turnUuid is
   *  omitted — every non-invalidated partial for the step), newest seq
   *  last. The chain walker takes the last entry to build the next
   *  attempt's prefill. */
  readAssistantPartials(runId: string, stepId: string, turnUuid?: string): Promise<AssistantPartialRecord[]>;
  /** Tombstone partials (set invalidated=1) so a re-run after
   *  cancel/fail doesn't resurrect stale state. Three modes by
   *  precision: whole run, run+step, or run+step+turn. */
  invalidatePartials(runId: string, stepId?: string, turnUuid?: string): Promise<void>;

  // ── Signals ──────────────────────────────────────────────────────
  enqueueSignal(runId: string, channel: string, payload: unknown): Promise<void>;
  /** Returns the oldest unconsumed signal payload on the channel; marks it consumed. */
  consumeSignal(runId: string, channel: string): Promise<unknown | null>;
  /**
   * Atomically consume the oldest unconsumed signal on `channel` AND
   * record its receipt as an `effect:completed` event, in a single
   * transaction. Returns the payload, or null if none is queued.
   *
   * Closes the crash-between-consume-and-record window in
   * `EffectRuntime.waitForSignal`: with the non-atomic `consumeSignal`
   * + separate `appendEvent`, a crash in between left the signal
   * consumed (gone from the queue) but unrecorded (no `effect:completed`)
   * — so replay saw an `effect:started` with no completion, re-polled,
   * found the queue empty, and hung forever. Doing both under one
   * transaction makes the receipt all-or-nothing.
   */
  consumeSignalAndRecord(
    runId: string,
    channel: string,
    effect: { stepId: string; effectKey: string; effectIdx: number },
  ): Promise<unknown | null>;
  /** Read-only — returns all signals (consumed + unconsumed) for tests / observability. */
  readSignals(runId: string, channel?: string): Promise<SignalRecord[]>;

  // ── Maintenance ──────────────────────────────────────────────────
  vacuum(olderThanIso: string): Promise<VacuumStats>;
  /** Closes any underlying handle (file descriptor, connection pool). */
  close(): Promise<void>;
}
