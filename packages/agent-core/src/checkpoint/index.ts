/**
 * `@anvil/agent-core/checkpoint` — barrel exports for the per-call agent
 * checkpoint cache (Phase 3 of the agent-manager consolidation).
 *
 * Lifted verbatim from dashboard's `dashboard/server/checkpoint-*.ts` +
 * `agent-runner-wrapper.ts` cluster. On-disk format unchanged
 * (`~/.anvil/checkpoints/<project>/<runFamily>/`); only the writer's owning
 * package moved.
 */

export { BlobStore, type BlobWriteResult, type BlobGcResult } from './blob-store.js';

export {
  CheckpointStore,
  type CheckpointStoreOpts,
  type CheckpointStatus,
} from './store.js';

export {
  computeFingerprint,
  computeKey,
  checkpointPath,
  checkpointRoot,
  blobPath,
  blobRoot,
} from './key.js';

export {
  runWithCheckpoint,
  type WrappedAgentOpts,
} from './runner.js';

export type {
  CheckpointStage,
  CheckpointInputs,
  CheckpointKey,
  CheckpointRecord,
  CheckpointStats,
} from './types.js';
