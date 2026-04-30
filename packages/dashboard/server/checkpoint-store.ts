/**
 * Backwards-compat re-export shim. The real implementation now lives in
 * `@anvil/agent-core/checkpoint/store`. Phase 6 of the agent-manager
 * consolidation deletes this file once direct imports flip everywhere.
 */

export { CheckpointStore } from '@anvil/agent-core';
export type { CheckpointStoreOpts, CheckpointStatus } from '@anvil/agent-core';
