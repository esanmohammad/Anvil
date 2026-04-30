/**
 * Backwards-compat re-export shim. The real implementation now lives in
 * `@anvil/agent-core/checkpoint/blob-store`. Phase 6 of the agent-manager
 * consolidation deletes this file once direct imports flip everywhere.
 */

export { BlobStore } from '@anvil/agent-core';
export type { BlobWriteResult, BlobGcResult } from '@anvil/agent-core';
