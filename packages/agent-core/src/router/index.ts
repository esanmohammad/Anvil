/**
 * `@anvil/agent-core/router` — barrel.
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
export type { LlmRouterDeps, AdapterResolver } from './router.js';
export { RouterError, classifyError, parseRetryAfterMs } from './errors.js';
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
