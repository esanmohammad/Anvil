/**
 * Phase 9 — Deterministic agent checkpoints.
 *
 * Types shared across the checkpoint subsystem: the key/fingerprint
 * computation (`checkpoint-key.ts`), the content-addressed blob store
 * (`checkpoint-blob-store.ts`), the record store (`checkpoint-store.ts`),
 * and the higher-order agent wrapper (`agent-runner-wrapper.ts`).
 *
 * A checkpoint is a per-(project, runFamily, stage, hash) record of whether
 * a particular agent invocation has already produced output, so that a
 * resumed run can skip it. The hash is a sha256 derived from a stable
 * fingerprint of every input that should invalidate the cache on drift
 * (prompt version, tool versions, model id, and the input payload).
 */

/** Logical pipeline stages that emit checkpoints. */
export type CheckpointStage =
  | 'plan'
  | 'implement'
  | 'review'
  | 'test'
  | 'ship'
  | 'kb-grounding'
  | 'mutation';

/** Lifecycle state of a single checkpoint record. */
export type CheckpointStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed';

/**
 * The inputs that go into computing a checkpoint key.
 *
 * Any field here drifts → different hash → cache miss → fresh run. Fields
 * are intentionally denormalized so callers don't forget to include
 * promptVersion / model etc.
 */
export interface CheckpointInputs {
  stage: CheckpointStage;
  /** Stable task identifier within a stage (e.g. "impl:src/foo.ts"). */
  taskId: string;
  /** Arbitrary JSON-serializable input payload; fingerprinted recursively. */
  inputs: unknown;
  /** Persona / prompt version string — bump to invalidate cached outputs. */
  promptVersion: string;
  /** Tool versions that materially affect output (e.g. { tsc: '5.3.3' }). */
  toolVersions?: Record<string, string>;
  /** Model identifier used for the invocation. */
  model?: string;
}

/** Identifier for a checkpoint, computed from CheckpointInputs. */
export interface CheckpointKey {
  /** sha256 hex string uniquely identifying the input set. */
  hash: string;
  /** Groups re-runs of the same logical run across retries / resumes. */
  runFamily: string;
  stage: CheckpointStage;
  taskId: string;
}

/** On-disk record for one checkpoint. */
export interface CheckpointRecord {
  key: CheckpointKey;
  project: string;
  status: CheckpointStatus;
  /** Content-addressed blob sha (hex) for the serialized output. */
  outputRef?: string;
  cost?: { usd: number; tokensIn: number; tokensOut: number };
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  errorMessage?: string;
}

/** Aggregate metrics for a run family. */
export interface CheckpointStats {
  total: number;
  hits: number;
  misses: number;
  interrupted: number;
  hitRate: number;
  costSavedUsd: number;
}
