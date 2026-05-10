/**
 * `@esankhan3/anvil-agent-core/agent/session` — barrel exports for the agent-lifecycle
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

// Default factory + bridge (the concrete production adapter resolution path).
export { LanguageModelBridge } from './language-model-bridge.js';
export {
  defaultAdapterFactory,
  defaultAdapterFactoryFn,
  resolveProvider,
} from './default-adapter-factory.js';
export type {
  AdapterCapabilities,
  AdapterCostInfo,
  PromptAwareAdapter,
} from './legacy-adapter-types.js';

// Single-shot helper for callers that don't need the full AgentManager
// registry (cli commands like diff, learn, migrate, test-gen).
export {
  runWithAgent,
  type RunWithAgentOptions,
  type RunWithAgentResult,
} from './run-with-agent.js';

// Eval-facing trajectory collector. Wraps an `AgentProcess` and aggregates
// an Inspect-AI-shaped `AgentTrajectory`. Replaces the headless `runAgent`
// per AGENT-PROCESS-CONSOLIDATION-ADR §C1.
export {
  collectTrajectory,
  type CollectTrajectoryOptions,
} from './collect-trajectory.js';

export type {
  AgentTask,
  AgentTrajectory,
  TrajectoryMessage,
  TrajectoryToolCall,
  TrajectoryUsage,
  WorkspaceConfig,
} from './headless-types.js';

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

// Process-level web/browser tool backend registry. The harness
// (dashboard / cli) wires this once at boot; the bridge composes a
// `WebToolExecutor` with these backends whenever a stage advertises
// web_*/browser_*/computer_use names.
export {
  setWebToolBackends,
  getWebToolBackends,
  clearWebToolBackends,
} from './web-tool-backends-registry.js';
