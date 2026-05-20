/**
 * In-memory `DurableStore` — drives tests + dev mode.
 *
 * Bit-identical semantics to the SQLite driver minus persistence.
 * Single-process only; no cross-instance visibility. Used by every
 * existing test that wires the bus + registry without a real disk
 * presence.
 */

import type { DurableStore, VacuumStats } from './store.js';
import type {
  EffectEventPair,
  EventRecord,
  NewEventRecord,
  NewRunRecord,
  RunRecord,
  RunStatus,
  SignalRecord,
} from './types.js';

interface InMemoryRun extends RunRecord {
  // alias for clarity
}

export class InMemoryDurableStore implements DurableStore {
  private readonly runs = new Map<string, InMemoryRun>();
  private readonly events = new Map<string, EventRecord[]>();
  private readonly signals = new Map<string, SignalRecord[]>();

  constructor(private readonly clock: () => number = Date.now) {}

  async createRun(run: NewRunRecord): Promise<RunRecord> {
    if (this.runs.has(run.runId)) {
      const existing = this.runs.get(run.runId)!;
      return { ...existing };
    }
    const ts = this.iso();
    const record: InMemoryRun = {
      runId: run.runId,
      project: run.project,
      feature: run.feature,
      featureSlug: run.featureSlug,
      status: 'pending',
      currentStep: null,
      cursorSeq: 0,
      startedAt: ts,
      updatedAt: ts,
      leaseHolder: null,
      leaseExpires: null,
      workflowVer: run.workflowVer ?? 1,
    };
    this.runs.set(run.runId, record);
    this.events.set(run.runId, []);
    this.signals.set(run.runId, []);
    return { ...record };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const r = this.runs.get(runId);
    return r ? { ...r } : null;
  }

  async updateRunStatus(
    runId: string,
    status: RunStatus,
    currentStep?: string | null,
  ): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`InMemoryDurableStore: unknown run ${runId}`);
    r.status = status;
    if (currentStep !== undefined) r.currentStep = currentStep;
    r.updatedAt = this.iso();
  }

  async updateRunCursor(runId: string, cursorSeq: number): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`InMemoryDurableStore: unknown run ${runId}`);
    r.cursorSeq = cursorSeq;
    r.updatedAt = this.iso();
  }

  async listRunsByStatus(status: RunStatus): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) => r.status === status).map((r) => ({ ...r }));
  }

  async acquireLease(runId: string, holder: string, ttlMs: number): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`InMemoryDurableStore: unknown run ${runId}`);
    const now = this.clock();
    const expiresMs = r.leaseExpires ? Date.parse(r.leaseExpires) : 0;
    if (r.leaseHolder && r.leaseHolder !== holder && expiresMs > now) {
      return false;
    }
    r.leaseHolder = holder;
    r.leaseExpires = new Date(now + ttlMs).toISOString();
    r.updatedAt = this.iso();
    return true;
  }

  async renewLease(runId: string, holder: string, ttlMs: number): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r) return false;
    if (r.leaseHolder !== holder) return false;
    r.leaseExpires = new Date(this.clock() + ttlMs).toISOString();
    r.updatedAt = this.iso();
    return true;
  }

  async releaseLease(runId: string, holder: string): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) return;
    if (r.leaseHolder !== holder) return;
    r.leaseHolder = null;
    r.leaseExpires = null;
    r.updatedAt = this.iso();
  }

  async appendEvent(event: NewEventRecord): Promise<EventRecord> {
    return (await this.appendBatch([event]))[0];
  }

  async appendBatch(events: NewEventRecord[]): Promise<EventRecord[]> {
    if (events.length === 0) return [];
    const out: EventRecord[] = [];
    for (const ev of events) {
      const arr = this.events.get(ev.runId);
      if (!arr) throw new Error(`InMemoryDurableStore: unknown run ${ev.runId}`);
      const seq = arr.length === 0 ? 1 : arr[arr.length - 1].seq + 1;
      const record: EventRecord = {
        runId: ev.runId,
        seq,
        kind: ev.kind,
        stepId: ev.stepId ?? null,
        effectKey: ev.effectKey ?? null,
        effectIdx: ev.effectIdx ?? null,
        payload: ev.payload,
        ts: ev.ts ?? this.iso(),
      };
      arr.push(record);
      out.push(record);
    }
    return out;
  }

  async readEvents(runId: string, fromSeq?: number): Promise<EventRecord[]> {
    const arr = this.events.get(runId) ?? [];
    if (fromSeq === undefined) return arr.map((e) => ({ ...e }));
    return arr.filter((e) => e.seq >= fromSeq).map((e) => ({ ...e }));
  }

  async readEffectEvents(runId: string, stepId: string): Promise<EffectEventPair[]> {
    const arr = this.events.get(runId) ?? [];
    const byKey = new Map<string, EffectEventPair>();
    const ordered: string[] = [];
    for (const ev of arr) {
      if (ev.stepId !== stepId) continue;
      if (
        ev.kind !== 'effect:started'
        && ev.kind !== 'effect:completed'
        && ev.kind !== 'effect:failed'
      ) {
        continue;
      }
      const key = `${ev.effectKey ?? ''}::${ev.effectIdx ?? 0}`;
      if (!byKey.has(key) && ev.kind === 'effect:started') {
        byKey.set(key, { started: { ...ev } });
        ordered.push(key);
      } else {
        const pair = byKey.get(key);
        if (!pair) continue;
        if (ev.kind === 'effect:completed') pair.completed = { ...ev };
        if (ev.kind === 'effect:failed') pair.failed = { ...ev };
      }
    }
    return ordered.map((k) => byKey.get(k)!);
  }

  async enqueueSignal(runId: string, channel: string, payload: unknown): Promise<void> {
    const arr = this.signals.get(runId);
    if (!arr) throw new Error(`InMemoryDurableStore: unknown run ${runId}`);
    arr.push({ runId, channel, payload, ts: this.iso(), consumed: false });
  }

  async consumeSignal(runId: string, channel: string): Promise<unknown | null> {
    const arr = this.signals.get(runId);
    if (!arr) return null;
    for (const s of arr) {
      if (s.channel === channel && !s.consumed) {
        s.consumed = true;
        return s.payload;
      }
    }
    return null;
  }

  async readSignals(runId: string, channel?: string): Promise<SignalRecord[]> {
    const arr = this.signals.get(runId) ?? [];
    return arr
      .filter((s) => channel === undefined || s.channel === channel)
      .map((s) => ({ ...s }));
  }

  async vacuum(olderThanIso: string): Promise<VacuumStats> {
    const cutoff = Date.parse(olderThanIso);
    let runsRemoved = 0;
    let eventsRemoved = 0;
    let signalsRemoved = 0;
    for (const [runId, r] of [...this.runs.entries()]) {
      const isTerminal = r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled';
      if (!isTerminal) continue;
      if (Date.parse(r.updatedAt) < cutoff) {
        eventsRemoved += this.events.get(runId)?.length ?? 0;
        signalsRemoved += this.signals.get(runId)?.length ?? 0;
        this.events.delete(runId);
        this.signals.delete(runId);
        this.runs.delete(runId);
        runsRemoved += 1;
      }
    }
    return { runs: runsRemoved, events: eventsRemoved, signals: signalsRemoved };
  }

  async close(): Promise<void> {
    /* no-op */
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }
}
