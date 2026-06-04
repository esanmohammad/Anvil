/**
 * SQLite-backed `DurableStore`.
 *
 * Default driver for v1. WAL journal mode + NORMAL sync — handles
 * ~1k writes/sec on consumer SSDs, well above our actual write rate
 * (events/sec/run).
 *
 * Schema is defined in §G of `docs/durable-execution-plan.md` and
 * created lazily on construction; the file is safe to delete at any
 * point — new runs work, old runs become unrecoverable (the
 * Pattern-1 audit log + state file remain as last-resort fallbacks).
 *
 * `better-sqlite3` is sync; we wrap calls in `async` so the
 * `DurableStore` interface stays uniform across drivers (in-memory,
 * future Postgres pool).
 */

import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
// `better-sqlite3` is the only fast Node sync driver. The interface
// stays Promise-based so a future Postgres driver can slot in
// without reshaping callers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Database, { type Database as DB, type Statement } from 'better-sqlite3';

import type { DurableStore, VacuumStats } from './store.js';
import {
  DurableStoreUnavailableError,
  type AssistantPartialRecord,
  type EffectEventPair,
  type EventRecord,
  type NewAssistantPartialRecord,
  type NewEventRecord,
  type NewRunRecord,
  type RunRecord,
  type RunStatus,
  type SignalRecord,
} from './types.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  project       TEXT NOT NULL,
  feature       TEXT NOT NULL,
  feature_slug  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('pending', 'running', 'paused', 'completed',
                   'failed', 'cancelled', 'compensating')),
  current_step  TEXT,
  cursor_seq    INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  lease_holder  TEXT,
  lease_expires TEXT,
  workflow_ver  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_project_feature ON runs(project, feature_slug);

CREATE TABLE IF NOT EXISTS events (
  run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  step_id    TEXT,
  effect_key TEXT,
  effect_idx INTEGER,
  payload    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_step ON events(run_id, step_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_effect ON events(run_id, step_id, effect_key, effect_idx);

CREATE TABLE IF NOT EXISTS signals (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  channel   TEXT NOT NULL,
  payload   TEXT NOT NULL,
  consumed  INTEGER NOT NULL DEFAULT 0,
  ts        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_pending
  ON signals(run_id, channel, consumed, id);

CREATE TABLE IF NOT EXISTS assistant_partials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,
  turn_uuid   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  partial_id  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0,
  ts          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_partials_turn
  ON assistant_partials(run_id, step_id, turn_uuid, seq);
CREATE INDEX IF NOT EXISTS idx_partials_step
  ON assistant_partials(run_id, step_id, id);
`;

const SCHEMA_VERSION = '1';

interface PreparedStmts {
  insertRun: Statement;
  selectRun: Statement;
  updateRunStatus: Statement;
  updateRunCursor: Statement;
  selectByStatus: Statement;
  acquireLeaseFresh: Statement;
  acquireLeaseSelect: Statement;
  renewLease: Statement;
  releaseLease: Statement;
  insertEvent: Statement;
  selectMaxSeq: Statement;
  selectEvents: Statement;
  selectEffects: Statement;
  insertSignal: Statement;
  selectNextSignal: Statement;
  consumeSignal: Statement;
  selectSignals: Statement;
  selectSignalsByChannel: Statement;
  vacuumRuns: Statement;
  insertPartial: Statement;
  selectMaxPartialSeq: Statement;
  selectPartialsByTurn: Statement;
  selectPartialsByStep: Statement;
  invalidatePartialsRun: Statement;
  invalidatePartialsStep: Statement;
  invalidatePartialsTurn: Statement;
}

export interface SQLiteDurableStoreOptions {
  /** Path to the .db file. Parent directory is created if missing. */
  path: string;
  /** Caller-supplied clock for tests. */
  clock?: () => number;
}

export class SQLiteDurableStore implements DurableStore {
  private readonly db: DB;
  private readonly stmts: PreparedStmts;
  private readonly clock: () => number;

  constructor(opts: SQLiteDurableStoreOptions) {
    this.clock = opts.clock ?? Date.now;
    const dir = dirname(opts.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    try {
      this.db = new Database(opts.path);
    } catch (err) {
      throw new DurableStoreUnavailableError(
        `Failed to open durable store at ${opts.path}`,
        err,
      );
    }
    this.db.exec(SCHEMA);
    this.upsertMeta('schema_version', SCHEMA_VERSION);

    this.stmts = {
      insertRun: this.db.prepare(`
        INSERT INTO runs (run_id, project, feature, feature_slug, status,
                          cursor_seq, started_at, updated_at, workflow_ver)
        VALUES (@runId, @project, @feature, @featureSlug, 'pending',
                0, @ts, @ts, @workflowVer)
      `),
      selectRun: this.db.prepare('SELECT * FROM runs WHERE run_id = ?'),
      updateRunStatus: this.db.prepare(`
        UPDATE runs SET status = @status,
                        current_step = COALESCE(@currentStep, current_step),
                        updated_at = @ts
         WHERE run_id = @runId
      `),
      updateRunCursor: this.db.prepare(
        'UPDATE runs SET cursor_seq = @cursorSeq, updated_at = @ts WHERE run_id = @runId',
      ),
      selectByStatus: this.db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY started_at'),
      acquireLeaseSelect: this.db.prepare('SELECT lease_holder, lease_expires FROM runs WHERE run_id = ?'),
      acquireLeaseFresh: this.db.prepare(`
        UPDATE runs SET lease_holder = @holder,
                        lease_expires = @expires,
                        updated_at = @ts
         WHERE run_id = @runId
      `),
      renewLease: this.db.prepare(`
        UPDATE runs SET lease_expires = @expires, updated_at = @ts
         WHERE run_id = @runId AND lease_holder = @holder
      `),
      releaseLease: this.db.prepare(`
        UPDATE runs SET lease_holder = NULL, lease_expires = NULL, updated_at = @ts
         WHERE run_id = @runId AND lease_holder = @holder
      `),
      insertEvent: this.db.prepare(`
        INSERT INTO events (run_id, seq, kind, step_id, effect_key, effect_idx, payload, ts)
        VALUES (@runId, @seq, @kind, @stepId, @effectKey, @effectIdx, @payload, @ts)
      `),
      selectMaxSeq: this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE run_id = ?'),
      selectEvents: this.db.prepare(
        'SELECT * FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq',
      ),
      selectEffects: this.db.prepare(`
        SELECT * FROM events
         WHERE run_id = ? AND step_id = ?
           AND kind IN ('effect:started', 'effect:completed', 'effect:failed')
         ORDER BY seq
      `),
      insertSignal: this.db.prepare(`
        INSERT INTO signals (run_id, channel, payload, consumed, ts)
        VALUES (@runId, @channel, @payload, 0, @ts)
      `),
      selectNextSignal: this.db.prepare(`
        SELECT id, payload FROM signals
         WHERE run_id = ? AND channel = ? AND consumed = 0
         ORDER BY id ASC LIMIT 1
      `),
      consumeSignal: this.db.prepare('UPDATE signals SET consumed = 1 WHERE id = ?'),
      selectSignals: this.db.prepare('SELECT * FROM signals WHERE run_id = ? ORDER BY id'),
      selectSignalsByChannel: this.db.prepare(
        'SELECT * FROM signals WHERE run_id = ? AND channel = ? ORDER BY id',
      ),
      vacuumRuns: this.db.prepare(`
        DELETE FROM runs
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND updated_at < ?
      `),
      insertPartial: this.db.prepare(`
        INSERT INTO assistant_partials
          (run_id, step_id, turn_uuid, seq, partial_id, payload, invalidated, ts)
        VALUES (@runId, @stepId, @turnUuid, @seq, @partialId, @payload, 0, @ts)
      `),
      selectMaxPartialSeq: this.db.prepare(`
        SELECT COALESCE(MAX(seq), 0) AS m FROM assistant_partials
         WHERE run_id = ? AND step_id = ? AND turn_uuid = ?
      `),
      // Order by `id` (global insertion order), NOT `seq` (per-turn) so a
      // step-wide read across turns surfaces the genuinely-most-recent
      // partial last. The caller takes the last row.
      selectPartialsByTurn: this.db.prepare(`
        SELECT * FROM assistant_partials
         WHERE run_id = ? AND step_id = ? AND turn_uuid = ? AND invalidated = 0
         ORDER BY id
      `),
      selectPartialsByStep: this.db.prepare(`
        SELECT * FROM assistant_partials
         WHERE run_id = ? AND step_id = ? AND invalidated = 0
         ORDER BY id
      `),
      invalidatePartialsRun: this.db.prepare(
        'UPDATE assistant_partials SET invalidated = 1 WHERE run_id = ?',
      ),
      invalidatePartialsStep: this.db.prepare(
        'UPDATE assistant_partials SET invalidated = 1 WHERE run_id = ? AND step_id = ?',
      ),
      invalidatePartialsTurn: this.db.prepare(
        'UPDATE assistant_partials SET invalidated = 1 WHERE run_id = ? AND step_id = ? AND turn_uuid = ?',
      ),
    };
  }

  async createRun(run: NewRunRecord): Promise<RunRecord> {
    const existing = this.stmts.selectRun.get(run.runId) as RunRow | undefined;
    if (existing) return rowToRecord(existing);

    const ts = this.iso();
    this.stmts.insertRun.run({
      runId: run.runId,
      project: run.project,
      feature: run.feature,
      featureSlug: run.featureSlug,
      ts,
      workflowVer: run.workflowVer ?? 1,
    });
    const row = this.stmts.selectRun.get(run.runId) as RunRow;
    return rowToRecord(row);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = this.stmts.selectRun.get(runId) as RunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async updateRunStatus(
    runId: string,
    status: RunStatus,
    currentStep?: string | null,
  ): Promise<void> {
    this.stmts.updateRunStatus.run({
      runId,
      status,
      currentStep: currentStep === undefined ? null : currentStep,
      ts: this.iso(),
    });
  }

  async updateRunCursor(runId: string, cursorSeq: number): Promise<void> {
    this.stmts.updateRunCursor.run({ runId, cursorSeq, ts: this.iso() });
  }

  async listRunsByStatus(status: RunStatus): Promise<RunRecord[]> {
    const rows = this.stmts.selectByStatus.all(status) as RunRow[];
    return rows.map(rowToRecord);
  }

  async acquireLease(runId: string, holder: string, ttlMs: number): Promise<boolean> {
    const acquire = this.db.transaction(() => {
      const row = this.stmts.acquireLeaseSelect.get(runId) as
        | { lease_holder: string | null; lease_expires: string | null }
        | undefined;
      if (!row) return false;
      const now = this.clock();
      const liveExpiry = row.lease_expires ? Date.parse(row.lease_expires) : 0;
      if (row.lease_holder && row.lease_holder !== holder && liveExpiry > now) {
        return false;
      }
      const expires = new Date(now + ttlMs).toISOString();
      this.stmts.acquireLeaseFresh.run({ runId, holder, expires, ts: this.iso() });
      return true;
    });
    return acquire();
  }

  async renewLease(runId: string, holder: string, ttlMs: number): Promise<boolean> {
    const expires = new Date(this.clock() + ttlMs).toISOString();
    const result = this.stmts.renewLease.run({ runId, holder, expires, ts: this.iso() });
    return (result.changes ?? 0) > 0;
  }

  async releaseLease(runId: string, holder: string): Promise<void> {
    this.stmts.releaseLease.run({ runId, holder, ts: this.iso() });
  }

  async appendEvent(event: NewEventRecord): Promise<EventRecord> {
    return (await this.appendBatch([event]))[0];
  }

  async appendBatch(events: NewEventRecord[]): Promise<EventRecord[]> {
    if (events.length === 0) return [];
    const out: EventRecord[] = [];
    const insert = this.db.transaction(() => {
      for (const ev of events) {
        const max = this.stmts.selectMaxSeq.get(ev.runId) as { m: number };
        const seq = (max?.m ?? 0) + 1;
        const ts = ev.ts ?? this.iso();
        const payloadJson = JSON.stringify(ev.payload ?? null);
        this.stmts.insertEvent.run({
          runId: ev.runId,
          seq,
          kind: ev.kind,
          stepId: ev.stepId ?? null,
          effectKey: ev.effectKey ?? null,
          effectIdx: ev.effectIdx ?? null,
          payload: payloadJson,
          ts,
        });
        out.push({
          runId: ev.runId,
          seq,
          kind: ev.kind,
          stepId: ev.stepId ?? null,
          effectKey: ev.effectKey ?? null,
          effectIdx: ev.effectIdx ?? null,
          payload: ev.payload ?? null,
          ts,
        });
      }
    });
    insert();
    return out;
  }

  async readEvents(runId: string, fromSeq?: number): Promise<EventRecord[]> {
    const rows = this.stmts.selectEvents.all(runId, fromSeq ?? 0) as EventRow[];
    return rows.map(eventRowToRecord);
  }

  async readEffectEvents(runId: string, stepId: string): Promise<EffectEventPair[]> {
    const rows = this.stmts.selectEffects.all(runId, stepId) as EventRow[];
    const byKey = new Map<string, EffectEventPair>();
    const ordered: string[] = [];
    for (const row of rows) {
      const ev = eventRowToRecord(row);
      const key = `${ev.effectKey ?? ''}::${ev.effectIdx ?? 0}`;
      if (ev.kind === 'effect:started') {
        if (!byKey.has(key)) {
          byKey.set(key, { started: ev });
          ordered.push(key);
        }
      } else {
        const pair = byKey.get(key);
        if (!pair) continue;
        if (ev.kind === 'effect:completed') pair.completed = ev;
        if (ev.kind === 'effect:failed') pair.failed = ev;
      }
    }
    return ordered.map((k) => byKey.get(k)!);
  }

  async appendAssistantPartial(partial: NewAssistantPartialRecord): Promise<AssistantPartialRecord> {
    const ts = this.iso();
    return this.db.transaction(() => {
      const max = this.stmts.selectMaxPartialSeq.get(
        partial.runId, partial.stepId, partial.turnUuid,
      ) as { m: number };
      const seq = (max?.m ?? 0) + 1;
      const partialId = `${partial.runId}:${partial.stepId}:${partial.turnUuid}:${seq}`;
      this.stmts.insertPartial.run({
        runId: partial.runId,
        stepId: partial.stepId,
        turnUuid: partial.turnUuid,
        seq,
        partialId,
        payload: JSON.stringify(partial.payload ?? null),
        ts,
      });
      return {
        runId: partial.runId,
        stepId: partial.stepId,
        turnUuid: partial.turnUuid,
        seq,
        partialId,
        payload: partial.payload ?? null,
        invalidated: false,
        ts,
      };
    })();
  }

  async readAssistantPartials(
    runId: string,
    stepId: string,
    turnUuid?: string,
  ): Promise<AssistantPartialRecord[]> {
    const rows = (turnUuid !== undefined
      ? this.stmts.selectPartialsByTurn.all(runId, stepId, turnUuid)
      : this.stmts.selectPartialsByStep.all(runId, stepId)) as PartialRow[];
    return rows.map(partialRowToRecord);
  }

  async invalidatePartials(runId: string, stepId?: string, turnUuid?: string): Promise<void> {
    if (turnUuid !== undefined) {
      if (stepId === undefined) {
        throw new Error('invalidatePartials: turnUuid requires stepId');
      }
      this.stmts.invalidatePartialsTurn.run(runId, stepId, turnUuid);
    } else if (stepId !== undefined) {
      this.stmts.invalidatePartialsStep.run(runId, stepId);
    } else {
      this.stmts.invalidatePartialsRun.run(runId);
    }
  }

  async enqueueSignal(runId: string, channel: string, payload: unknown): Promise<void> {
    this.stmts.insertSignal.run({
      runId,
      channel,
      payload: JSON.stringify(payload ?? null),
      ts: this.iso(),
    });
  }

  async consumeSignal(runId: string, channel: string): Promise<unknown | null> {
    const consume = this.db.transaction(() => {
      const row = this.stmts.selectNextSignal.get(runId, channel) as
        | { id: number; payload: string }
        | undefined;
      if (!row) return null;
      this.stmts.consumeSignal.run(row.id);
      return safeParse(row.payload);
    });
    return consume();
  }

  async consumeSignalAndRecord(
    runId: string,
    channel: string,
    effect: { stepId: string; effectKey: string; effectIdx: number },
  ): Promise<unknown | null> {
    // One transaction: pop the signal AND append its effect:completed
    // receipt. A crash either commits both or neither — never the torn
    // "consumed but unrecorded" state that hung replay.
    const tx = this.db.transaction(() => {
      const row = this.stmts.selectNextSignal.get(runId, channel) as
        | { id: number; payload: string }
        | undefined;
      if (!row) return null;
      this.stmts.consumeSignal.run(row.id);
      const seq = ((this.stmts.selectMaxSeq.get(runId) as { m: number })?.m ?? 0) + 1;
      this.stmts.insertEvent.run({
        runId,
        seq,
        kind: 'effect:completed',
        stepId: effect.stepId,
        effectKey: effect.effectKey,
        effectIdx: effect.effectIdx,
        payload: row.payload, // already a JSON string in the signals table
        ts: this.iso(),
      });
      return safeParse(row.payload);
    });
    return tx();
  }

  async readSignals(runId: string, channel?: string): Promise<SignalRecord[]> {
    const rows = (channel
      ? this.stmts.selectSignalsByChannel.all(runId, channel)
      : this.stmts.selectSignals.all(runId)) as SignalRow[];
    return rows.map((r) => ({
      runId: r.run_id,
      channel: r.channel,
      payload: safeParse(r.payload),
      ts: r.ts,
      consumed: r.consumed === 1,
    }));
  }

  async vacuum(olderThanIso: string): Promise<VacuumStats> {
    const eventsBefore = (this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    const signalsBefore = (this.db.prepare('SELECT COUNT(*) AS c FROM signals').get() as { c: number }).c;
    const result = this.stmts.vacuumRuns.run(olderThanIso);
    const eventsAfter = (this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    const signalsAfter = (this.db.prepare('SELECT COUNT(*) AS c FROM signals').get() as { c: number }).c;
    return {
      runs: result.changes ?? 0,
      events: eventsBefore - eventsAfter,
      signals: signalsBefore - signalsAfter,
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private upsertMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }
}

interface RunRow {
  run_id: string;
  project: string;
  feature: string;
  feature_slug: string;
  status: RunStatus;
  current_step: string | null;
  cursor_seq: number;
  started_at: string;
  updated_at: string;
  lease_holder: string | null;
  lease_expires: string | null;
  workflow_ver: number;
}

interface EventRow {
  run_id: string;
  seq: number;
  kind: string;
  step_id: string | null;
  effect_key: string | null;
  effect_idx: number | null;
  payload: string;
  ts: string;
}

interface SignalRow {
  run_id: string;
  channel: string;
  payload: string;
  consumed: number;
  ts: string;
}

interface PartialRow {
  id: number;
  run_id: string;
  step_id: string;
  turn_uuid: string;
  seq: number;
  partial_id: string;
  payload: string;
  invalidated: number;
  ts: string;
}

function rowToRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    project: row.project,
    feature: row.feature,
    featureSlug: row.feature_slug,
    status: row.status,
    currentStep: row.current_step,
    cursorSeq: row.cursor_seq,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    leaseHolder: row.lease_holder,
    leaseExpires: row.lease_expires,
    workflowVer: row.workflow_ver,
  };
}

function eventRowToRecord(row: EventRow): EventRecord {
  return {
    runId: row.run_id,
    seq: row.seq,
    kind: row.kind as EventRecord['kind'],
    stepId: row.step_id,
    effectKey: row.effect_key,
    effectIdx: row.effect_idx,
    payload: safeParse(row.payload),
    ts: row.ts,
  };
}

function partialRowToRecord(row: PartialRow): AssistantPartialRecord {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    turnUuid: row.turn_uuid,
    seq: row.seq,
    partialId: row.partial_id,
    payload: safeParse(row.payload),
    invalidated: row.invalidated === 1,
    ts: row.ts,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
