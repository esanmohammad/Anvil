/**
 * Backwards-compat re-export shim. The real implementation now lives in
 * `@anvil/agent-core/checkpoint/key`. Phase 6 of the agent-manager
 * consolidation deletes this file once direct imports flip everywhere.
 */

export {
  computeFingerprint,
  computeKey,
  checkpointPath,
  checkpointRoot,
  blobPath,
  blobRoot,
} from '@anvil/agent-core';
