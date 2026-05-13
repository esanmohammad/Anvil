/**
 * `@esankhan3/anvil-core-pipeline/utils` — shared utility helpers used
 * by both cli and dashboard pipeline drivers. Pure functions, no
 * filesystem / network side effects.
 */

export {
  heuristicTokenCount,
  heuristicTokenCountFromBytes,
  countTokens,
} from './token-util.js';
export { structurallyTruncate, looksLikeCode } from './structural-truncator.js';
export type { StructuralTruncateOptions } from './structural-truncator.js';
export {
  parseSections,
  findSection,
  sliceSpecForRefs,
} from './engineer-spec-slicer.js';
export type {
  SpecSection,
  SliceOptions,
  SliceResult,
} from './engineer-spec-slicer.js';
export {
  enforceBudget,
  estimateBudgetTokens,
} from './prompt-budget.js';
export type {
  PromptSection,
  BudgetOptions,
  BudgetDecision,
  BudgetResult,
} from './prompt-budget.js';
export {
  getModelTokenLimit,
  estimateTokens,
  applyBudget,
  budgetPromptContext,
} from './context-budget.js';
export type {
  ContextComponent,
  ContextBudgetResult,
  PromptBudgetInput,
  PromptBudgetOutput,
} from './context-budget.js';
export {
  parseTasks,
  groupTasksForExecution,
  runTasksWithDependencyGraph,
  extractAllTaskFiles,
  bundleFiles,
} from './engineer-task-bundler.js';
export type {
  ParsedTask,
  ExecutionGroup,
  BundleOptions,
  SkipReason,
  BundleResult,
  RunTasksOptions,
  RunTasksHooks,
} from './engineer-task-bundler.js';
export type {
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
  // v2 additions
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
} from './plan-types.js';
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
} from './plan-types.js';
export {
  renderRequirements,
  renderRepoRequirements,
  renderRepoSpecs,
  renderRepoTasks,
  planCoversRepo,
  planCoversStagesForRepo,
  planCoversCrossRepo,
  summarisePlanSkip,
} from './plan-to-artifacts.js';
export {
  SCORER_VERSION,
  SENSITIVE_PATH_PATTERNS,
} from './plan-risk-types.js';
export type {
  RiskTier,
  RiskFactor,
  RiskScore,
} from './plan-risk-types.js';
export {
  scorePlan,
  computeRiskTier,
} from './plan-risk-scorer.js';
export type {
  ScorePlanOpts,
} from './plan-risk-scorer.js';
export {
  FEATURE_MANIFEST_VERSION,
  emptyManifest,
} from './feature-manifest-types.js';
export type {
  FieldStatus,
  ManifestField,
  ApiEndpoint,
  TableMutation,
  PlannedFile,
  TestBehavior,
  FeatureManifest,
  ManifestFieldKey,
  ManifestFieldValue,
} from './feature-manifest-types.js';
export {
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractTablesTouched,
  extractFilesPlanned,
  extractTestBehaviors,
  extractChangeBrief,
  extractOpenQuestions,
} from './feature-manifest-extractors.js';
export type {
  ExtractorResult,
  ManifestExtractor,
} from './feature-manifest-extractors.js';
