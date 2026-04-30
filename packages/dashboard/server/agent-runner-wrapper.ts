/**
 * Backwards-compat re-export shim. The real implementation now lives in
 * `@anvil/agent-core/checkpoint/runner`. Phase 6 of the agent-manager
 * consolidation deletes this file once direct imports flip everywhere.
 */

export { runWithCheckpoint } from '@anvil/agent-core';
export type { WrappedAgentOpts } from '@anvil/agent-core';
