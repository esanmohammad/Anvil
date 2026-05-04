/**
 * CheckpointStore — persistence for CheckpointRecord JSON files.
 *
 * Storage layout:
 *   <anvilHome>/checkpoints/<project>/<runFamily>/<stage>/<hash>.json
 *   <anvilHome>/checkpoints/_blobs/<sha[0:2]>/<sha>      (via BlobStore)
 *
 * All writes go through tmp + renameSync for atomicity. Missing or corrupt
 * JSON files are treated as absent (get returns null and logs to stderr).
 *
 * ── Stats accounting (approximate) ───────────────────────────────────────
 *
 * `stats()` mixes two data sources:
 *   - On-disk counts (total/completed/interrupted/failed) are authoritative.
 *   - `hits` is an in-memory counter incremented inside `get()` every time a
 *     caller observes a `completed` record. `misses` counts `begin()` calls.
 *
 * This means `hits` resets across process restarts — it reflects *this*
 * process's cache-reuse activity, not lifetime reuse. `hitRate` is computed
 * as hits / (hits + misses). The costSavedUsd estimate sums the cost of
 * each observed hit (i.e. the cost Anvil would have paid to re-run it).
 * Misses before a restart are not retroactively credited.
 *
 * This approximation is documented here and referenced by the integration
 * notes. It's intentional: we don't need a durable hit counter for the
 * main goal (skip already-done work); the metric is informational.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { BlobStore } from './blob-store.js';
import { checkpointPath, checkpointRoot, computeKey } from './key.js';
import type {
  CheckpointInputs,
  CheckpointKey,
  CheckpointRecord,
  CheckpointStage,
  CheckpointStats,
  CheckpointStatus,
} from './types.js';

const STAGES: CheckpointStage[] = [
  'plan',
  'implement',
  'review',
  'test',
  'ship',
  'kb-grounding',
  'mutation',
];

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteFileSync(filePath: string, data: string): void {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function readRecord(filePath: string): CheckpointRecord | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as CheckpointRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    process.stderr.write(
      `[checkpoint-store] skipping corrupt record ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
}

export interface CheckpointStoreOpts {
  anvilHome: string;
  blobStore: BlobStore;
}

export class CheckpointStore {
  private readonly anvilHome: string;
  private readonly blobStore: BlobStore;

  /** In-memory hit/miss counters; see file header for semantics. */
  private hitCount = 0;
  private missCount = 0;
  private hitCostUsd = 0;

  constructor(opts: CheckpointStoreOpts) {
    this.anvilHome = opts.anvilHome;
    this.blobStore = opts.blobStore;
  }

  /**
   * Look up a checkpoint by key. Returns null when missing or corrupt. If the
   * returned record is `completed` and its blob exists, increments the hit
   * counter (and adds its recorded cost to costSavedUsd).
   */
  get(
    project: string,
    runFamily: string,
    key: CheckpointKey,
  ): CheckpointRecord | null {
    const path = checkpointPath(
      this.anvilHome,
      project,
      runFamily,
      key.stage,
      key.hash,
    );
    const record = readRecord(path);
    if (!record) return null;
    if (
      record.status === 'completed' &&
      record.outputRef &&
      this.blobStore.exists(record.outputRef)
    ) {
      this.hitCount += 1;
      if (record.cost?.usd) this.hitCostUsd += record.cost.usd;
    }
    return record;
  }

  /** Persist a record to disk atomically. */
  write(project: string, record: CheckpointRecord): void {
    const path = checkpointPath(
      this.anvilHome,
      project,
      record.key.runFamily,
      record.key.stage,
      record.key.hash,
    );
    atomicWriteFileSync(path, JSON.stringify(record, null, 2));
  }

  /**
   * Claim a checkpoint: write `status: 'running'` with startedAt. Used
   * before the agent executes so interrupted runs can be detected on
   * resume. Counts as a cache miss.
   */
  begin(
    project: string,
    runFamily: string,
    inputs: CheckpointInputs,
    cost?: CheckpointRecord['cost'],
  ): CheckpointRecord {
    const key = computeKey(runFamily, inputs);
    const record: CheckpointRecord = {
      key,
      project,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...(cost ? { cost } : {}),
    };
    this.write(project, record);
    this.missCount += 1;
    return record;
  }

  /**
   * Mark a checkpoint completed with its serialized output. Writes the blob
   * first (so a subsequent `get` that sees the record always finds bytes).
   */
  complete(
    project: string,
    runFamily: string,
    key: CheckpointKey,
    output: string | Buffer,
    cost?: CheckpointRecord['cost'],
  ): CheckpointRecord {
    const blob = this.blobStore.write(output);
    const path = checkpointPath(
      this.anvilHome,
      project,
      runFamily,
      key.stage,
      key.hash,
    );
    const existing = readRecord(path);
    const startedAt = existing?.startedAt ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const record: CheckpointRecord = {
      key,
      project,
      status: 'completed',
      outputRef: blob.sha,
      startedAt,
      completedAt,
      durationMs,
      ...(cost ? { cost } : existing?.cost ? { cost: existing.cost } : {}),
    };
    this.write(project, record);
    return record;
  }

  /**
   * Mark a checkpoint as interrupted (SIGTERM / cost-reject / user cancel).
   * If a partial output is provided, it is stored as a blob so the next
   * resume can inspect it.
   */
  interrupt(
    project: string,
    runFamily: string,
    key: CheckpointKey,
    partialOutput?: string | Buffer,
    reason?: string,
  ): CheckpointRecord {
    const path = checkpointPath(
      this.anvilHome,
      project,
      runFamily,
      key.stage,
      key.hash,
    );
    const existing = readRecord(path);
    const startedAt = existing?.startedAt ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    let outputRef: string | undefined;
    if (partialOutput !== undefined) {
      outputRef = this.blobStore.write(partialOutput).sha;
    }
    const record: CheckpointRecord = {
      key,
      project,
      status: 'interrupted',
      startedAt,
      completedAt,
      durationMs,
      ...(outputRef ? { outputRef } : {}),
      ...(reason ? { errorMessage: reason } : {}),
      ...(existing?.cost ? { cost: existing.cost } : {}),
    };
    this.write(project, record);
    return record;
  }

  /** Mark a checkpoint as failed with the error message. */
  fail(
    project: string,
    runFamily: string,
    key: CheckpointKey,
    err: string,
  ): CheckpointRecord {
    const path = checkpointPath(
      this.anvilHome,
      project,
      runFamily,
      key.stage,
      key.hash,
    );
    const existing = readRecord(path);
    const startedAt = existing?.startedAt ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const record: CheckpointRecord = {
      key,
      project,
      status: 'failed',
      startedAt,
      completedAt,
      durationMs,
      errorMessage: err,
      ...(existing?.cost ? { cost: existing.cost } : {}),
    };
    this.write(project, record);
    return record;
  }

  /**
   * Enumerate every checkpoint record for a given run family across all
   * stages. Skips corrupt files silently.
   */
  listForRun(project: string, runFamily: string): CheckpointRecord[] {
    const runDir = join(checkpointRoot(this.anvilHome), project, runFamily);
    if (!existsSync(runDir)) return [];
    const out: CheckpointRecord[] = [];
    let stageDirs: string[];
    try {
      stageDirs = readdirSync(runDir);
    } catch {
      return [];
    }
    for (const stage of stageDirs) {
      if (!(STAGES as string[]).includes(stage)) continue;
      const stageDir = join(runDir, stage);
      let files: string[];
      try {
        files = readdirSync(stageDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const rec = readRecord(join(stageDir, file));
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /**
   * Delete on-disk records for a stage within a run. Does NOT touch blobs
   * (those are content-addressed; use `BlobStore.gc` for that).
   */
  invalidateStage(
    project: string,
    runFamily: string,
    stage: CheckpointStage,
  ): number {
    const stageDir = join(
      checkpointRoot(this.anvilHome),
      project,
      runFamily,
      stage,
    );
    if (!existsSync(stageDir)) return 0;
    let count = 0;
    let files: string[];
    try {
      files = readdirSync(stageDir);
    } catch {
      return 0;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        unlinkSync(join(stageDir, file));
        count += 1;
      } catch {
        // best effort
      }
    }
    return count;
  }

  /** Aggregate stats for a run family. See file header for approximation notes. */
  stats(project: string, runFamily: string): CheckpointStats {
    const records = this.listForRun(project, runFamily);
    const total = records.length;
    const interrupted = records.filter((r) => r.status === 'interrupted').length;
    const hits = this.hitCount;
    const misses = this.missCount;
    const denom = hits + misses;
    const hitRate = denom === 0 ? 0 : hits / denom;
    return {
      total,
      hits,
      misses,
      interrupted,
      hitRate,
      costSavedUsd: this.hitCostUsd,
    };
  }

  /** Visible for tests: reset in-memory hit/miss accounting. */
  resetCounters(): void {
    this.hitCount = 0;
    this.missCount = 0;
    this.hitCostUsd = 0;
  }

  /** Visible for tests: current in-memory counters. */
  getCounters(): { hits: number; misses: number; hitCostUsd: number } {
    return { hits: this.hitCount, misses: this.missCount, hitCostUsd: this.hitCostUsd };
  }
}

export type { CheckpointStatus };
