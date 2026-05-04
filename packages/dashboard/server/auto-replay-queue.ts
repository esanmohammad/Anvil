/**
 * auto-replay-queue — in-memory FIFO queue for bug-to-test replay jobs with a
 * crash-safe mirror on disk.
 *
 * Contract:
 *   - `enqueue(incidentId, project)` adds a job at the tail (dedup on
 *     incidentId+project — a second enqueue of the same pair is a no-op so we
 *     don't double-run an in-flight job).
 *   - `pump(execute)` runs one scheduling pass: up to `maxConcurrent` jobs are
 *     popped from the head and handed to `execute`. Each call is awaited; on
 *     success the job is removed from the persisted mirror. On failure the
 *     job's `attempts` counter is incremented and — if still under
 *     `maxAttempts` — it is re-enqueued at the tail. Otherwise it is dropped.
 *   - `snapshot()` returns the current queue for UI display.
 *
 * Persistence:
 *   ~/.anvil/incidents/queue.json — writen atomically on every mutation so
 *   that a crash during `pump` leaves the queue in a recoverable state (at
 *   worst, an in-flight job that already ran will be re-run on restart; that
 *   is acceptable for replays because the underlying store dedups on
 *   (source, externalId)).
 *
 * This is deliberately simple — a single-process sequential sweep, not a full
 * scheduler. The caller invokes `pump` on a timer.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { IncidentSeverity } from './incident-types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AutoReplayJob {
  incidentId: string;
  project: string;
  enqueuedAt: string;
  attempts: number;
}

export interface AutoReplayQueueOptions {
  /** Maximum number of jobs to pass to `execute` per `pump` call. Default: 2. */
  maxConcurrent?: number;
  /** How many times to retry a job before dropping it. Default: 3. */
  maxAttempts?: number;
  /** Severity floor — advisory; the caller is responsible for filtering. */
  minSeverity?: IncidentSeverity;
}

// ── AutoReplayQueue ──────────────────────────────────────────────────────

export class AutoReplayQueue {
  private jobs: AutoReplayJob[] = [];
  private readonly diskPath: string;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly minSeverity: IncidentSeverity;
  /** In-flight jobs, keyed so we don't re-hand them out on a reentrant pump. */
  private readonly inFlight = new Set<string>();

  constructor(anvilHome: string, opts: AutoReplayQueueOptions = {}) {
    this.diskPath = join(anvilHome, 'incidents', 'queue.json');
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.minSeverity = opts.minSeverity ?? 'p3';
    this.jobs = this.loadFromDisk();
  }

  /**
   * Add a job to the tail. No-op if the same (incidentId, project) pair is
   * already queued or in-flight.
   */
  enqueue(incidentId: string, project: string): void {
    const key = jobKey(incidentId, project);
    if (this.inFlight.has(key)) return;
    if (this.jobs.some((j) => jobKey(j.incidentId, j.project) === key)) return;
    this.jobs.push({
      incidentId,
      project,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    });
    this.persist();
  }

  /**
   * Run one scheduling pass. Up to `maxConcurrent` jobs are dispatched in
   * parallel via `Promise.all`. Failed jobs are re-enqueued (with attempts++)
   * unless they have hit `maxAttempts`, in which case they are dropped.
   */
  async pump(execute: (job: AutoReplayJob) => Promise<void>): Promise<void> {
    const batch: AutoReplayJob[] = [];
    while (batch.length < this.maxConcurrent && this.jobs.length > 0) {
      const next = this.jobs.shift()!;
      const key = jobKey(next.incidentId, next.project);
      this.inFlight.add(key);
      batch.push(next);
    }
    if (batch.length === 0) return;
    this.persist();

    await Promise.all(
      batch.map(async (job) => {
        const key = jobKey(job.incidentId, job.project);
        try {
          await execute(job);
        } catch {
          // Retry: bump attempts and re-queue unless maxAttempts exhausted.
          const nextAttempts = job.attempts + 1;
          if (nextAttempts < this.maxAttempts) {
            this.jobs.push({
              ...job,
              attempts: nextAttempts,
              enqueuedAt: new Date().toISOString(),
            });
          }
          // else: drop. Caller will see it gone from snapshot().
        } finally {
          this.inFlight.delete(key);
          this.persist();
        }
      }),
    );
  }

  /** Returns a defensive copy of the current queue (tail order). */
  snapshot(): AutoReplayJob[] {
    return this.jobs.map((j) => ({ ...j }));
  }

  /** The `minSeverity` configured at construction. */
  getMinSeverity(): IncidentSeverity {
    return this.minSeverity;
  }

  // ── Disk mirror ─────────────────────────────────────────────────────────

  private loadFromDisk(): AutoReplayJob[] {
    if (!existsSync(this.diskPath)) return [];
    try {
      const raw = readFileSync(this.diskPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const out: AutoReplayJob[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (
          typeof r.incidentId === 'string' &&
          typeof r.project === 'string' &&
          typeof r.enqueuedAt === 'string' &&
          typeof r.attempts === 'number' &&
          Number.isFinite(r.attempts)
        ) {
          out.push({
            incidentId: r.incidentId,
            project: r.project,
            enqueuedAt: r.enqueuedAt,
            attempts: r.attempts,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private persist(): void {
    const parent = dirname(this.diskPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const tmp = `${this.diskPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.jobs, null, 2), 'utf-8');
    renameSync(tmp, this.diskPath);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function jobKey(incidentId: string, project: string): string {
  return `${project}::${incidentId}`;
}

/**
 * Advisory severity comparison: returns true if `actual` meets-or-exceeds
 * `floor` on the P1 > P2 > P3 > P4 ladder. `unknown` never meets any floor
 * other than itself. Exposed so callers can filter before `enqueue`.
 */
export function meetsSeverityFloor(
  actual: IncidentSeverity,
  floor: IncidentSeverity,
): boolean {
  const rank: Record<IncidentSeverity, number> = {
    p1: 4,
    p2: 3,
    p3: 2,
    p4: 1,
    unknown: 0,
  };
  if (actual === 'unknown') return floor === 'unknown';
  return rank[actual] >= rank[floor];
}
