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
