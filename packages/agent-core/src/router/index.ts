/**
 * `@esankhan3/anvil-agent-core/router` — barrel.
 *
 * Public surface for the LLM router subsystem. See
 * `AGENT-CORE-LLM-ROUTER-PLAN.md` for the phased rollout.
 */

export type {
  ErrorClass,
  RetryPolicy,
  RouteFallback,
  RouteConfig,
  BudgetConfig,
  CircuitBreakerConfig,
  RateLimitProviderConfig,
  RouterConfig,
  InvokeOpts,
  RouteAttempt,
  RouteOutcome,
} from './types.js';
export { ALL_ERROR_CLASSES } from './types.js';
export { LlmRouter } from './router.js';
export type {
  LlmRouterDeps,
  AdapterResolver,
  AgentChainOptions,
  AgentChainResult,
} from './router.js';
export {
  ProviderRegistryAdapterResolver,
  providerRegistryAdapterResolver,
  getAgentReliabilityRouter,
  _resetAgentReliabilityRouter,
} from './provider-registry-resolver.js';
export {
  RouterError,
  classifyError,
  parseRetryAfterMs,
  isTerminalErrorClass,
  isFallbackEligibleErrorClass,
} from './errors.js';
export { runWithRetry, DEFAULT_RETRY_POLICY } from './retry.js';
export type { RetryAttempt, RunWithRetryDeps, RunWithRetryResult } from './retry.js';
export {
  TokenBucketRateLimiter,
  RateLimitedError,
  DEFAULT_RATE_LIMITS,
} from './rate-limiter.js';
export type { RateLimiterDeps } from './rate-limiter.js';
export {
  SpendLedger,
  SPEND_LEDGER_SCHEMA_SQL,
  defaultSpendLedgerPath,
} from './spend-ledger.js';
export type { SpendRow, SpendQueryOpts } from './spend-ledger.js';
export { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER } from './circuit-breaker.js';
export type { CircuitBreakerDeps, CircuitState } from './circuit-breaker.js';
export {
  loadRouterConfig,
  findRouterConfigPath,
  defaultRouterConfig,
  mergeWithDefaults,
} from './config-loader.js';
export type { LoadRouterConfigOptions } from './config-loader.js';
export {
  invokeWithSpans,
  ROUTER_INVOKE_SPAN,
  ROUTER_ATTEMPT_SPAN,
  RouterAttr,
} from './telemetry.js';
export {
  loadModelRegistry,
  parseModelRegistry,
  findModelsConfigPath,
  DEFAULT_WALKER_CONFIG,
  ModelRegistryParseError,
  ModelRegistryValidationError,
} from './model-registry.js';
export type {
  ModelEntry,
  ModelRegistry,
  ModelAvailability,
  ModelCapability,
  ModelComplexity,
  ModelTier,
  ModelConsumer,
  WalkerConfig,
  LoadModelRegistryOptions,
} from './model-registry.js';
export { resolveModel, ModelResolutionError } from './resolver.js';
export type {
  ResolveModelOptions,
  ResolvedChain,
  ResolutionDiagnostic,
} from './resolver.js';
export { LocalExecutor, localExecutor } from './local-executor.js';
export type {
  LocalExecutorDeps,
  LocalExecutorInspection,
} from './local-executor.js';
export { discoverAvailability } from './discovery.js';
export type {
  DiscoveryAdapter,
  DiscoveryDeps,
  DiscoveryOptions,
} from './discovery.js';
