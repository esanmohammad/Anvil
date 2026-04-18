/**
 * Resilience & Self-Healing — barrel exports.
 */

// Section A — Agent Watchdog
export { HeartbeatMonitor, type HeartbeatConfig } from './heartbeat-monitor.js';
export { CrashRecovery, type CrashAttempt, type CrashRecoveryConfig } from './crash-recovery.js';
export { StageTimeoutManager, type StageTimeoutConfig, type TimeoutResult } from './stage-timeout.js';
export { ContextOverflowDetector, type ContextOverflowConfig, type ContextStatus, MODEL_TOKEN_LIMITS } from './context-overflow.js';
export { GarbageDetector, type GarbageReport, type GarbageIssue, type GarbageDetectorConfig } from './garbage-detector.js';

// Section B — Output Validation Gates
export { ValidatorRegistry, type StageValidator, type ValidationResult } from './validator-registry.js';
export { ClarifyValidator } from './validators/clarify-validator.js';
export { AnalystValidator, ProjectRequirementsValidator } from './validators/analyst-validator.js';
export { ArchitectValidator } from './validators/architect-validator.js';
export { LeadValidator } from './validators/lead-validator.js';
export { EngineerValidator } from './validators/engineer-validator.js';
export { TesterValidator } from './validators/tester-validator.js';

// Section C — Escalation Chain
export {
  EscalationLevel,
  ESCALATION_CHAIN,
  DEFAULT_ESCALATION_CONFIG,
  getNextLevel,
  type EscalationEvent,
  type EscalationChainConfig,
} from './escalation-types.js';
export { EscalationEngine } from './escalation-engine.js';
export {
  handleEscalation,
  getHandlerForLevel,
  LeadEscalationHandler,
  ArchitectEscalationHandler,
  AnalystEscalationHandler,
  HumanEscalationHandler,
  type EscalationAction,
  type EscalationHandler,
} from './escalation-handlers.js';

// Section D — State Recovery
export { atomicWrite, atomicWriteJSON } from './atomic-write.js';
export { SnapshotManager, type SnapshotManagerConfig } from './snapshot-manager.js';
export { CheckpointIntegrity, type IntegrityResult } from './checkpoint-integrity.js';
export { DiskSpaceGuard, type DiskSpaceStatus, type DiskSpaceConfig } from './disk-space-guard.js';
export { IncompleteCheckpointDetector, type IncompleteCheckpoint, type IncompleteCheckpointConfig } from './incomplete-checkpoint.js';

// Section E — External Project Resilience
export { McpResilience, type McpResilienceConfig, type McpCallResult } from './mcp-resilience.js';
export { GitHubBuffer, type GitHubBufferConfig, type BufferedOperation } from './github-buffer.js';
export { DeployResilience, type DeployResilienceResult } from './deploy-resilience.js';
export { RateLimitBackoff, type RateLimitConfig, type RateLimitInfo } from './rate-limit-backoff.js';
export { OfflineDetector, type OfflineStatus, type QueuedOperation } from './offline-mode.js';
