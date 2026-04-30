/**
 * `@anvil/agent-core/agent/session` — barrel exports for the unified
 * agent-lifecycle layer (Phase 1 of the agent-manager consolidation).
 */

export {
  AgentSession,
  emptyCost,
} from './session.js';

export { AgentSessionRegistry } from './session-registry.js';

export type {
  AgentActivity,
  AgentCheckpointHook,
  AgentCostHook,
  AgentSessionEvents,
  AgentSessionRegistryEvents,
  AgentSessionState,
  AgentSessionStatus,
  CostInfo,
  SessionSpec,
} from './types.js';

export {
  AgentSessionNotFoundError,
  SessionResumeNotSupportedError,
} from './types.js';
