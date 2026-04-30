/**
 * Backwards-compat re-export shim for the dashboard's pre-Phase-4 surface.
 * The real implementation now lives in `@anvil/agent-core`. Phase 6 of the
 * agent-manager consolidation deletes this file once direct imports flip
 * everywhere.
 *
 * Name mapping (per ADR D2):
 *   AgentManager        → AgentSessionRegistry
 *   AgentState          → AgentSessionState
 *   SpawnConfig         → SessionSpec
 *   AgentManagerEvents  → AgentSessionRegistryEvents
 *   AgentCostHook       → AgentCostHook (unchanged)
 *   AgentCheckpointHook → AgentCheckpointHook (unchanged)
 */

export {
  AgentSessionRegistry as AgentManager,
  type AgentSessionState as AgentState,
  type SessionSpec as SpawnConfig,
  type AgentSessionRegistryEvents as AgentManagerEvents,
  type AgentCostHook,
  type AgentCheckpointHook,
} from '@anvil/agent-core';

// Convenience re-export — dashboard `agent-manager.ts` historically also
// surfaced the checkpoint wrapper from this module.
export { runWithCheckpoint } from '@anvil/agent-core';
export type { WrappedAgentOpts } from '@anvil/agent-core';
