/**
 * Vector-index lifecycle on the write path: decides when the IVF index is
 * built, left alone, or retrained, and records its training + health in the
 * `vector_index.json` blob.
 *
 * optimize() folds appended rows into the existing centroids but never
 * re-fits them, so as the table grows or churns the partitions drift away from
 * the data (bigger partitions ⇒ slower probes; stale centroids ⇒ lower recall,
 * worse for IVF_PQ whose codebook is frozen too). The writer therefore counts
 * rows written since the last training and retrains in place once that reaches
 * `trainedRows × ratio` (default 1: 2× growth or a full turnover).
 *
 * The table is the source of truth for whether an index exists; the blob only
 * carries what the table can't tell us (training size, rows since). One vector
 * table and one writer per project (the existing sole-writer invariant).
 */

import type { VectorIndexHealth } from './types.js';
import type { BlobStorePort, VectorIndexState, VectorIndexType, VectorStorePort } from './storage/ports.js';

export const VECTOR_INDEX_KEY = 'vector_index.json';

/** A retrain that started but never completed (OOM kill, crash, or a caught
 *  failure) is not retried for this long, so a retrain that can't fit doesn't
 *  take down every writer run. */
const RETRAIN_BACKOFF_MS = 24 * 3_600_000;

export type VectorIndexAction = 'ensure' | 'retrain' | 'backoff' | 'none';

export interface VectorIndexPlan {
  action: VectorIndexAction;
  /** Why a retrain is (or would be) due. */
  reason?: 'untracked' | 'type-change' | 'growth';
}

/** `CODE_SEARCH_VECTOR_RETRAIN_RATIO`: retrain once rows written since the last
 *  training reach `trainedRows × ratio`. Default 1; 0 disables retraining
 *  (except for a configured index-type change). */
export function vectorRetrainRatio(): number {
  const n = parseFloat(process.env.CODE_SEARCH_VECTOR_RETRAIN_RATIO ?? '');
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** Pure decision: what the writer should do with the vector index this run. */
export function planVectorIndex(
  meta: VectorIndexHealth | null,
  state: VectorIndexState | null,
  opts: { ratio: number; rowsWritten: number; desiredType: VectorIndexType; now: number },
): VectorIndexPlan {
  if (!state) return { action: 'none' };
  if (!state.index) return { action: 'ensure' };

  // A configured index-type change always retrains; ratio 0 turns off the
  // untracked and growth retrains.
  let reason: VectorIndexPlan['reason'];
  const liveType = state.index.indexType;
  if ((liveType === 'IVF_FLAT' || liveType === 'IVF_PQ') && liveType !== opts.desiredType) {
    reason = 'type-change';
  } else if (opts.ratio > 0 && meta?.trainedRows == null) {
    reason = 'untracked';
  } else if (opts.ratio > 0 && meta?.trainedRows != null
    && meta.rowsAddedSinceTrain + opts.rowsWritten >= meta.trainedRows * opts.ratio) {
    reason = 'growth';
  }
  if (!reason) return { action: 'none' };

  const started = meta?.retrainStartedAt ? Date.parse(meta.retrainStartedAt) : NaN;
  const trained = meta?.trainedAt ? Date.parse(meta.trainedAt) : NaN;
  const unfinished = Number.isFinite(started) && !(trained >= started);
  if (unfinished && opts.now - started < RETRAIN_BACKOFF_MS) return { action: 'backoff', reason };
  return { action: 'retrain', reason };
}

export async function readVectorIndexHealth(blobs: BlobStorePort): Promise<VectorIndexHealth | null> {
  try {
    return await blobs.getJson<VectorIndexHealth>(VECTOR_INDEX_KEY);
  } catch {
    return null;
  }
}

/**
 * Run the vector-index step of a writer cycle: build / retrain as planned,
 * optimize (fold appends, compact, prune), then record training + health.
 * `rowsWritten` = rows added to the table this run. Non-fatal throughout —
 * failures are logged and recorded in `lastError`; a failed retrain keeps the
 * old index and the counter. Returns the record, or null when there is no
 * vector index (no table, or below minRows).
 */
export async function maintainVectorIndex(
  vectors: VectorStorePort,
  blobs: BlobStorePort,
  opts: { rowsWritten: number; log?: (msg: string) => void; ratio?: number; minRows?: number },
): Promise<VectorIndexHealth | null> {
  const log = opts.log ?? ((msg: string) => console.error(`[knowledge-core] ${msg}`));
  const save = async (record: VectorIndexHealth): Promise<void> => {
    try {
      await blobs.putJson(VECTOR_INDEX_KEY, record);
    } catch (err) {
      log(`vector index record write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const readState = (): Promise<VectorIndexState | null> => vectors.vectorIndexState().catch(() => null);

  const meta = await readVectorIndexHealth(blobs);
  const plan = planVectorIndex(meta, await readState(), {
    ratio: opts.ratio ?? vectorRetrainRatio(),
    rowsWritten: opts.rowsWritten,
    desiredType: vectors.desiredVectorIndexType(),
    now: Date.now(),
  });

  const record: VectorIndexHealth = {
    ...meta,
    rowsAddedSinceTrain: (meta?.rowsAddedSinceTrain ?? 0) + opts.rowsWritten,
    checkedAt: new Date().toISOString(),
  };
  delete record.lastError;
  let outcome: string = plan.action === 'backoff' ? `retrain (${plan.reason}) backed off — last attempt at ${meta?.retrainStartedAt} did not finish` : '';

  if (plan.action === 'ensure' || plan.action === 'retrain') {
    if (plan.action === 'retrain') {
      record.retrainStartedAt = new Date().toISOString();
      await save(record);
    }
    const result = await vectors.ensureVectorIndex({ minRows: opts.minRows, retrain: plan.action === 'retrain' });
    if (result.status === 'built' || result.status === 'retrained') {
      Object.assign(record, {
        indexType: result.indexType,
        numPartitions: result.numPartitions,
        trainedRows: result.rows,
        trainedAt: new Date().toISOString(),
        rowsAddedSinceTrain: 0,
      });
      delete record.retrainStartedAt;
      await save(record);
      outcome = result.status === 'retrained' ? `retrained (${plan.reason}) in ${result.durationMs}ms` : `built in ${result.durationMs}ms`;
    } else if (result.status === 'failed') {
      record.lastError = result.error;
      outcome = `${plan.action === 'retrain' ? `retrain (${plan.reason})` : 'build'} failed`;
    }
  }

  // Fold appends into every index + compact + prune — even with no vector
  // index yet (FTS/scalar indexes and fragments need it too).
  await vectors.optimizeIndexes();

  const after = await readState();
  if (!after) {
    // State unreadable (transient I/O) — keep the record rather than dropping
    // it, which would cost an untracked retrain on the next run.
    if (!meta && record.trainedRows == null) return null;
    record.lastError ??= 'vector index state unreadable';
    await save(record);
    return record;
  }
  if (!after.index) {
    if (meta) {
      try { await blobs.delete(VECTOR_INDEX_KEY); } catch { /* stale record only */ }
    }
    return null;
  }
  Object.assign(record, {
    indexType: after.index.indexType,
    numIndexedRows: after.index.numIndexedRows,
    numUnindexedRows: after.index.numUnindexedRows,
    checkedAt: new Date().toISOString(),
  });
  await save(record);

  const since = record.trainedRows
    ? `+${record.rowsAddedSinceTrain} since training on ${record.trainedRows} (${Math.round((record.rowsAddedSinceTrain / record.trainedRows) * 100)}%)`
    : 'training untracked';
  log(
    `vector index ${record.indexType} partitions=${record.numPartitions ?? '?'} ${since}, ` +
      `unindexed=${record.numUnindexedRows}${outcome ? ` — ${outcome}` : ''}`,
  );
  return record;
}
