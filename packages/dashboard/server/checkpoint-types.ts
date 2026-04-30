/**
 * Backwards-compat re-export shim. The real types now live in
 * `@anvil/agent-core/checkpoint/types`. Phase 6 of the agent-manager
 * consolidation deletes this file once direct imports flip everywhere.
 */

export type {
  CheckpointStage,
  CheckpointStatus,
  CheckpointInputs,
  CheckpointKey,
  CheckpointRecord,
  CheckpointStats,
} from '@anvil/agent-core';
