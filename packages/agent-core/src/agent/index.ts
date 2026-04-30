/**
 * Agent Process Manager — barrel exports.
 */

export {
  type AgentProcessConfig,
  type AgentProcessState,
  type AgentEvent,
  type AgentResult,
  type ValidationResult,
  STAGE_TIMEOUT_DEFAULTS,
  getDefaultTimeout,
  createDefaultConfig,
} from './types.js';

export { spawnAgent, type AgentProcess } from './spawn.js';
export { StreamParser } from './stream-parser.js';
export { OutputBuffer } from './output-buffer.js';
export { RestartPolicy } from './restart-policy.js';
export { TimeoutGuard } from './timeout-guard.js';
export { StageValidator } from './stage-validator.js';
export { AgentManager, type SpawnFn } from './agent-manager.js';

// Phase 1 of the agent-manager consolidation: type skeletons for the unified
// agent-lifecycle layer. Runtime behavior lands in Phase 2; these exports
// exist now so consumers can rename imports incrementally.
export * from './session/index.js';
