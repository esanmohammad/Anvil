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
