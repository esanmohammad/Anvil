/**
 * `@anvil/core-pipeline` barrel.
 *
 * Public surface for the typed Step<I,O> graph + EventBus + StepRegistry +
 * lifecycle hooks. See CORE-PIPELINE-EXTRACT-PLAN.md for the phased rollout.
 */

export type {
  Step,
  StepContext,
  StepRetryPolicy,
  StepHookPoint,
  PipelineEvent,
  EventBus,
  EventListener,
  EventListenerOptions,
  StepRegistry,
  ReadonlyArtifactStore,
  PipelineRunResult,
  MemoryHandles,
  LlmHandles,
  BusRequest,
  BusRequestListener,
  BusRequestOptions,
} from './types.js';
export { InMemoryEventBus } from './event-bus.js';
export {
  BusRequestRegistry,
  BusRequestTimeoutError,
  BusRequestAbortedError,
} from './bus-request.js';
export { InMemoryStepRegistry } from './step-registry.js';
export { InMemoryArtifactStore } from './artifacts.js';
export { Pipeline, makePipelineEvent } from './pipeline.js';
export type { PipelineDeps } from './pipeline.js';
export {
  attachAuditLogHook,
  AUDIT_LOG_HOOKS,
  attachDashboardStateHook,
  attachCostTrackerHook,
  attachLearnersHook,
  attachRunStoreHook,
  attachFeatureStoreHook,
  attachApprovalGateHook,
  APPROVAL_GATE_CHANNEL,
} from './hooks/index.js';
export type {
  AuditLogHookOptions,
  AuditLogHookHandle,
  DashboardStateHookOptions,
  DashboardStateHookHandle,
  DashboardStateSnapshot,
  CostTrackerHookOptions,
  CostTrackerHookHandle,
  LearnersHookOptions,
  LearnersHookHandle,
  RunStoreLike,
  RunStoreHookOptions,
  RunStoreHookHandle,
  FeatureStoreHookOptions,
  FeatureStoreHookHandle,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalGateHookOptions,
  ApprovalGateHookHandle,
} from './hooks/index.js';
export { VERSION } from './version.js';

// — Routing (stage policy + capability/complexity resolver + task envelope)
export {
  loadStagePolicy,
  validateStagePolicy,
  findStagePolicyPath,
  StagePolicyLoadError,
  StagePolicyValidationError,
} from './routing/load-stage-policy.js';
export type {
  StagePolicy,
  StagePolicyMap,
  LoadStagePolicyOptions,
} from './routing/load-stage-policy.js';
export {
  resolveModelForStage,
  initStageRouting,
  UnknownStageError,
  ModelResolutionError,
  _resetStageRoutingCache,
} from './routing/resolve-model-for-stage.js';
export type { ResolveModelForStageOptions } from './routing/resolve-model-for-stage.js';
export {
  parseTaskEnvelope,
  parseTaskEnvelopeArray,
  TaskEnvelopeValidationError,
} from './routing/task-envelope.js';
export type {
  TaskEnvelope,
  TaskOperation,
  TaskRouting,
  TaskAcceptanceCriterion,
  TaskAcceptancePredicate,
  TaskAcceptanceProse,
  TaskTestRequirement,
} from './routing/task-envelope.js';
export { extractTaskEnvelopes, buildRetryPrompt } from './routing/extract-task-envelopes.js';
export type { ExtractResult, ExtractFailureReason } from './routing/extract-task-envelopes.js';
export {
  STAGE_TOOL_PERMISSIONS,
  allowedToolsForStage,
  permissionClassesForStage,
} from './routing/stage-permissions.js';
export type { ToolClass } from './routing/stage-permissions.js';
