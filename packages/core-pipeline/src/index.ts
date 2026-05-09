/**
 * `@esankhan3/anvil-core-pipeline` barrel.
 *
 * Public surface for the typed Step<I,O> graph + EventBus + StepRegistry +
 * lifecycle hooks. See CORE-PIPELINE-EXTRACT-PLAN.md for the phased rollout.
 */

export type {
  Step,
  StepContext,
  StepSkipContext,
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
  // Dashboard-domain event payload shapes (ADR §4.5)
  StageRepoProgressPayload,
  StageCostUpdatePayload,
  StageFixAttemptPayload,
  ReviewerNotePayload,
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
  heuristicTokenCount,
  heuristicTokenCountFromBytes,
  countTokens,
  structurallyTruncate,
  looksLikeCode,
  parseSections,
  findSection,
  sliceSpecForRefs,
  enforceBudget,
  estimateBudgetTokens,
  getModelTokenLimit,
  estimateTokens,
  applyBudget,
  budgetPromptContext,
  parseTasks,
  groupTasksForExecution,
  runTasksWithDependencyGraph,
  extractAllTaskFiles,
  bundleFiles,
  renderRequirements,
  renderRepoRequirements,
  renderRepoSpecs,
  renderRepoTasks,
  planCoversRepo,
  planCoversStagesForRepo,
  planCoversCrossRepo,
  summarisePlanSkip,
} from './utils/index.js';
export type {
  StructuralTruncateOptions,
  SpecSection,
  SliceOptions,
  SliceResult,
  PromptSection,
  BudgetOptions,
  BudgetDecision,
  BudgetResult,
  ContextComponent,
  ContextBudgetResult,
  PromptBudgetInput,
  PromptBudgetOutput,
  ParsedTask,
  ExecutionGroup,
  BundleOptions,
  SkipReason,
  BundleResult,
  RunTasksOptions,
  RunTasksHooks,
  RiskSeverity,
  ContractKind,
  PlanRepoImpact,
  PlanContract,
  PlanRisk,
  PlanRollout,
  PlanTests,
  PlanEstimate,
  Plan,
  PlanPointer,
  PlanSection,
  PlanComment,
  PlanApproval,
} from './utils/index.js';
export { buildStandardStepRegistry } from './standard-registry.js';
export type {
  RunStageResult,
  RunStageFn,
  StandardRegistryDeps,
} from './standard-registry.js';
export {
  attachAuditLogHook,
  AUDIT_LOG_HOOKS,
  attachDashboardStateHook,
  attachDashboardStateRollupHook,
  attachCostTrackerHook,
  attachLearnersHook,
  attachRunStoreHook,
  attachFeatureStoreHook,
  attachApprovalGateHook,
  APPROVAL_GATE_CHANNEL,
  attachStreamHook,
  attachCheckpointHook,
  createFileCheckpointStore,
  attachPrUrlHook,
  PR_URL_REGEX,
  attachLivenessPrefetchHook,
} from './hooks/index.js';
export type {
  AuditLogHookOptions,
  AuditLogHookHandle,
  DashboardStateHookOptions,
  DashboardStateHookHandle,
  DashboardStateSnapshot,
  DashboardRollupState,
  DashboardRollupStageState,
  DashboardRollupRepoState,
  DashboardStateRollupHookOptions,
  DashboardStateRollupHookHandle,
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
  StreamSnapshot,
  StreamHookOptions,
  StreamHookHandle,
  CheckpointStatus,
  CheckpointSnapshot,
  CheckpointStore,
  CheckpointHookOptions,
  CheckpointHookHandle,
  FileCheckpointStoreOptions,
  PrUrlHookOptions,
  PrUrlHookHandle,
  LivenessPrefetchHookOptions,
  LivenessPrefetchHookHandle,
} from './hooks/index.js';
export { VERSION } from './version.js';

// — Agent invocation surface (canonical AgentRunner type)
export type { AgentRunner, AgentRunRequest, AgentRunResult } from './agent-runner.js';
export type { AgentSession, AgentSessionResult } from './agent-session.js';

// — Chain-fallback for retryable upstream failures
export type { ChainFallbackOptions, BurnInfo } from './routing/with-fallback.js';
export { runWithChainFallback, isRetryableUpstreamError } from './routing/with-fallback.js';

// — Stage logic owned by core-pipeline
export type { StageContext, StageOutput, StageTokens } from './stages/types.js';
export { emptyStageTokens } from './stages/types.js';
export type { StageDefinition, StagePersona } from './stages/registry.js';
export { STAGES, STAGE_NAMES, getStage, getStageByIndex } from './stages/registry.js';
export type { ShipPromptInput } from './stages/ship.js';
export { buildShipUserPrompt, extractPrUrls, extractSandboxUrl } from './stages/ship.js';
export type { PerRepoStageOptions } from './stages/per-repo.js';
export { runPerRepoStage } from './stages/per-repo.js';
export type { PerRepoTelemetryRecord, TelemetryWriterOptions } from './stages/telemetry.js';
export { writePerRepoTelemetry, formatTelemetrySummary } from './stages/telemetry.js';
export type {
  BuildStageOptions,
  BuildStageTask,
  BuildTaskOutput,
  BuildRepoResult,
  RunTasksWithDependencyGraph,
} from './stages/build.js';
export { runBuildStage } from './stages/build.js';
export type { ValidateStageOptions, ValidateRepoResult } from './stages/validate.js';
export { runValidateStage } from './stages/validate.js';
export type { ClarifyQAPair, ClarifyQALoopOptions, ClarifyQALoopResult } from './stages/clarify.js';
export {
  parseClarifyQuestions,
  formatQAPairs,
  buildClarifySynthesisPrompt,
  runClarifyQALoop,
  deriveClarifyQuestions,
} from './stages/clarify.js';

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
export {
  resolveModelForTask,
  orderTasksForDispatch,
  TaskCycleError,
} from './routing/resolve-model-for-task.js';
export type {
  ResolveModelForTaskOptions,
  OrderedTaskBatch,
} from './routing/resolve-model-for-task.js';
export type { TaskPriority } from './routing/task-envelope.js';
