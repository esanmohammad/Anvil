/**
 * `@esankhan3/anvil-core-pipeline` barrel.
 *
 * Public surface for the typed Step<I,O> graph + EventBus + StepRegistry +
 * lifecycle hooks. See CORE-PIPELINE-EXTRACT-PLAN.md for the phased rollout.
 */

// Phase G — *Like interfaces for FS-backed dashboard storage layers
export type {
  FeatureStoreLike,
  FeatureManifestStoreLike,
  KbManagerLike,
  ProjectLoaderLike,
} from './storage-like.js';

// Phase H — Step factories
export {
  createClarifyStep,
  CLARIFY_QA_ARTIFACT_ID,
} from './steps/clarify.step.js';
export type {
  ClarifyStepOptions,
  ClarifyResult,
  ClarifyEvent,
} from './steps/clarify.step.js';
export {
  runValidate,
  hasValidationFailures,
  extractRepoSection,
} from './steps/validate.step.js';
export type {
  RunValidateOptions,
  RunValidateResult,
} from './steps/validate.step.js';
export {
  runFix,
} from './steps/fix.step.js';
export type {
  RunFixOptions,
  RunFixResult,
} from './steps/fix.step.js';
export {
  createFeatureManifestStep,
  FEATURE_MANIFEST_STAGES,
} from './steps/feature-manifest.step.js';
export type {
  FeatureManifestStepOptions,
} from './steps/feature-manifest.step.js';
export {
  createTaskBundlerStep,
  TASK_BUNDLES_ARTIFACT_ID,
} from './steps/task-bundler.step.js';
export type {
  TaskBundleOutput,
  TaskBundlerStepOptions,
} from './steps/task-bundler.step.js';
export {
  createPlanRiskStep,
  PLAN_RISK_ARTIFACT_ID,
} from './steps/plan-risk.step.js';
export type {
  PlanRiskStepOptions,
} from './steps/plan-risk.step.js';
export {
  createClarifyStageStep,
  runClarifyForProject,
} from './steps/clarify-stage.step.js';
export type {
  ClarifyStageStepOptions,
  RunClarifyForProjectOptions,
  RunClarifyForProjectResult,
} from './steps/clarify-stage.step.js';
export {
  createFixLoopStep,
  runFixLoop,
} from './steps/fix-loop.step.js';
export type {
  FixLoopStepOptions,
  RunFixLoopOptions,
  RunFixLoopResult,
} from './steps/fix-loop.step.js';
export {
  disallowedToolsForPersona,
  runPerRepoStageForRepo,
  combinePerRepoArtifacts,
  createPerRepoStageStep,
} from './steps/per-repo-stage.step.js';
export type {
  RunPerRepoStageOptions,
  RunPerRepoStageResult,
  PerRepoStageStepOptions,
} from './steps/per-repo-stage.step.js';
export {
  runBuildForOneRepo,
  combineTaskArtifacts,
  createPerRepoBuildStep,
  BUILD_DISALLOWED_TOOLS,
} from './steps/per-repo-build.step.js';
export type {
  RunBuildForRepoOptions,
  RunBuildForRepoResult,
  PerRepoBuildStepOptions,
} from './steps/per-repo-build.step.js';
export {
  pickRepoForBehavior,
  runTestGenForProject,
  createTestGenStageStep,
} from './steps/test-gen-stage.step.js';
export {
  loadPersonaPromptSync,
  injectTemplateVars,
  warnIfSystemPromptOversized,
  buildManifestPrefix,
  buildProjectPrompt,
  buildRepoProjectPrompt,
  buildClarifyExplorePrompt,
  buildStagePrompt,
  buildRepoStagePrompt,
  buildPerTaskPrompt,
} from './steps/prompt-builders.js';
export type {
  PromptBuilderContext,
  PromptBuilderProjectInfo,
  StageInfo,
  RepoArtifacts,
  KbTier,
} from './steps/prompt-builders.js';
export type {
  TestGenConventions,
  TestGenBehavior,
  TestGenSpec,
  TestGenCase,
  TestSpecStoreLike,
  TestCaseStoreLike,
  TestGenDeps,
  TestGenArtifactEvent,
  RunTestGenForProjectOptions,
  TestGenStageStepOptions,
} from './steps/test-gen-stage.step.js';
// `ClarifyQAPair` is already exported from `stages/clarify.ts`; the
// step's local interface is structurally identical, so we don't
// re-export it here to avoid a duplicate-identifier error.

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
  SCORER_VERSION,
  SENSITIVE_PATH_PATTERNS,
  scorePlan,
  computeRiskTier,
  FEATURE_MANIFEST_VERSION,
  emptyManifest,
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractTablesTouched,
  extractFilesPlanned,
  extractTestBehaviors,
  extractChangeBrief,
  extractOpenQuestions,
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
  RiskBlastRadius,
  ContractKind,
  PlanRepoImpact,
  PlanContract,
  PlanRisk,
  PlanRollout,
  RolloutStrategy,
  PlanTests,
  PlanEstimate,
  Plan,
  PlanPointer,
  PlanSection,
  PlanComment,
  PlanApproval,
  // Plan v2 additions
  PlanProblem,
  PlanScope,
  ScopeItem,
  FileClaim,
  FileClaimKind,
  SymbolClaim,
  SymbolKind,
  DataChange,
  DataChangeKind,
  Observability,
  ObservabilitySignal,
  TestCaseSpec,
  ManualStep,
  ColumnSpec,
  TypeRef,
  PlanCreatedBy,
  PlanApprovalRecord,
  RiskTier,
  RiskFactor,
  RiskScore,
  ScorePlanOpts,
  FieldStatus,
  ManifestField,
  ApiEndpoint,
  TableMutation,
  PlannedFile,
  TestBehavior,
  FeatureManifest,
  ManifestFieldKey,
  ManifestFieldValue,
  ExtractorResult,
  ManifestExtractor,
} from './utils/index.js';
export {
  planRepoTouchedPaths,
  planRepoTouchedCount,
  planAllTestCases,
  planAllTouchedPaths,
  planContractDisplayName,
  planContractDescription,
  planContractConsumers,
  planRepoSymbolNames,
  planTestDescriptions,
} from './utils/index.js';

// — Plan v2 — schema migration, content-hash, verifier, plan-binding
export {
  migratePlanJsonToV2,
  emptyPlanV2,
  planContentHash,
  planContentHashShort,
  runPlanRules,
  defaultRulePack,
  bindPlan,
} from './plan/index.js';
export type {
  Issue,
  IssueSeverity,
  RuleContext,
  PlanRule,
  AutoFixSuggestion,
  PlanValidationReport,
  PlanBinding,
} from './plan/index.js';

// — Plan v2 — compliance gates (Phases E, F, G)
export {
  checkBuildCompliance,
  renderBuildComplianceMarkdown,
  buildComplianceFixPrompt,
  checkValidateCompliance,
  renderValidateComplianceMarkdown,
  reconcilePlan,
} from './plan/index.js';
export type {
  BuildComplianceReport,
  BuildComplianceProbes,
  ComplianceGap,
  GapKind,
  ValidateComplianceReport,
  ValidateComplianceProbes,
  ValidateComplianceGap,
  ValidateGapKind,
  TestRunStatus,
  PlanReconciliation,
  ReconcileInput,
} from './plan/index.js';

// — Plan v2 — Phase I: cost policy + auto-refine
export {
  DEFAULT_COST_POLICY,
  resolveCostPolicy,
  CostBreachError,
  autoRefinePlan,
} from './plan/index.js';
export type { CostPolicy, AutoRefineOutcome } from './plan/index.js';

// — Plan v2 — lifecycle walker
export {
  initLifecycle,
  transitionLifecycle,
  snapshotLifecycle,
} from './plan/index.js';
export type {
  LifecycleState,
  LifecycleContext,
  LifecycleEvent,
  LifecycleAction,
  LifecycleTransition,
  LifecycleSnapshot,
  TransitionResult,
} from './plan/index.js';
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
  migrateLegacyCheckpoint,
  attachDurableLogHook,
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
  LegacyPipelineCheckpoint,
  MigratedCheckpointShared,
} from './hooks/index.js';
export { VERSION } from './version.js';

// — Agent invocation surface (canonical AgentRunner type)
export type { AgentRunner, AgentRunRequest, AgentRunResult } from './agent-runner.js';
export type { AgentSession, AgentSessionResult } from './agent-session.js';

// Chain-fallback (`runWithChainFallback` / `isRetryableUpstreamError`) was
// removed in the reliability rewrite — agentic chain walking + per-error-class
// backoff + circuit breaking now live in `LlmRouter.runAgent`
// (`@esankhan3/anvil-agent-core`). Error classification is the unified
// `classifyError` there.

// — Stage logic owned by core-pipeline
export type { StageContext, StageOutput, StageTokens, FeatureScope } from './stages/types.js';
export { emptyStageTokens } from './stages/types.js';
export { parseFeatureScope } from './stages/parse-scope.js';
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

// — Durable execution (Phases D1–D6 + E0–E10 + F1–F9 + G1–G4)
export type {
  RunStatus,
  NewRunRecord,
  RunRecord,
  DurableEventKind,
  NewEventRecord,
  EventRecord,
  EffectEventPair,
  SignalRecord,
  DurableStore,
  VacuumStats,
  SQLiteDurableStoreOptions,
  LintViolation,
  ModelCost,
  StepCostRollup,
  StepContinuation,
  AssistantPartialRecord,
  NewAssistantPartialRecord,
  ThrowingSpyOptions,
} from './durable/index.js';
export {
  DeterminismViolationError,
  DurableStoreUnavailableError,
  EffectResultNotSerialisableError,
  Pattern1MigrationError,
  InMemoryDurableStore,
  SQLiteDurableStore,
  lintStepSource,
  LeaseManager,
  tryTakeOverLease,
  findOrphanedRuns,
  serializeAgentRunResult,
  contentHash,
  artifactIdempotencyKey,
  seedStoreFromLog,
  throwingSpy,
  countingSpy,
  DURABLE_WRITE_OPS,
  // H3 turn-level resume + cost rollup + per-repo/task isolation primitive.
  readCompletedTurns,
  nextTurnSeed,
  buildPrefillFromPartial,
  reconstructSessionHistory,
  estimatePrefillTokens,
  rollupStepCostByModel,
  rollupStepCostAcrossSubsteps,
  mergeRollups,
  rollupIsEmpty,
  EffectRuntime,
  createScopedEffectRuntime,
  effectKeyMatchesScope,
} from './durable/index.js';

// — Stage Q&A primitives (used by clarify + per-stage questions panel)
export {
  STAGE_QA_PROMPT_HEADER,
  parseStageQuestions,
  formatStageAnswers,
} from './stages/qa.js';
