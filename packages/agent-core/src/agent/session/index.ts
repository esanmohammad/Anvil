/**
 * `@anvil/agent-core/agent/session` — barrel exports for the agent-lifecycle
 * layer. agent-core is the canonical source of truth for `AgentManager`
 * (registry of many) and `AgentProcess` (one logical agent).
 */

export {
  AgentProcess,
  emptyCost,
  generateSessionId,
  appendOutput,
  pushActivity,
  accumulateCost,
  type AgentProcessOpts,
} from './session.js';

export {
  AgentManager,
  type AgentManagerOpts,
} from './session-registry.js';

export type {
  AgentAdapter,
  AgentAdapterEvents,
  AgentAdapterFactory,
  AdapterRequest,
} from './adapter.js';
export { buildAdapterRequest } from './adapter.js';

export type {
  AgentActivity,
  AgentCheckpointHook,
  AgentCostHook,
  AgentManagerEvents,
  AgentProcessEvents,
  AgentState,
  AgentStatus,
  CostInfo,
  SpawnConfig,
} from './types.js';

export {
  AgentNotFoundError,
  SessionResumeNotSupportedError,
} from './types.js';
