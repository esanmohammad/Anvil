/**
 * `@anvil/agent-core/router` — schema types.
 *
 * Locked verbatim in `AGENT-CORE-LLM-ROUTER-ADR.md` §4. Keep this file
 * declaration-only — runtime behavior lives in router.ts and friends.
 */

import type {
  LanguageModelInvokeOptions,
  InvokeResult,
  ProviderName,
} from '../types.js';

// ────────────────────────────────────────────────────────────────────────────
// Error classification
// ────────────────────────────────────────────────────────────────────────────

export type ErrorClass =
  | 'rate_limit'
  | 'timeout'
  | 'server_5xx'
  | 'auth'
  | 'content_policy'
  | 'invalid_request'
  | 'unknown';

export const ALL_ERROR_CLASSES: readonly ErrorClass[] = [
  'rate_limit',
  'timeout',
  'server_5xx',
  'auth',
  'content_policy',
  'invalid_request',
  'unknown',
] as const;

// ────────────────────────────────────────────────────────────────────────────
// Retry policy
// ────────────────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  /** 0 = no retry. The total attempt count is `attempts + 1`. */
  attempts: number;
  backoff: 'exponential' | 'linear' | 'constant';
  /** Base backoff in milliseconds. */
  baseMs: number;
  /** Ceiling for exponential growth. */
  maxMs?: number;
  /** Default true — adds ±25% jitter to the computed delay. */
  jitter?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Route + budget config
// ────────────────────────────────────────────────────────────────────────────

export interface RouteFallback {
  model: string;
  /** Restrict this fallback to specified error classes; undefined = any retryable. */
  on?: ErrorClass[];
}

export interface RouteConfig {
  tag: string;
  primary: string;
  fallbacks?: RouteFallback[];
}

export interface BudgetConfig {
  dailyUsd?: number;
  perRunUsd?: number;
  perTagUsd?: Record<string, number>;
  /** Behavior when a budget is exhausted. */
  onBreach: 'fail' | 'downgrade' | 'queue';
}

export interface CircuitBreakerConfig {
  /** Open after N consecutive failures. */
  failureThreshold: number;
  /** Half-open after this window. */
  cooldownMs: number;
  /** Number of probe attempts during half-open. */
  halfOpenAttempts: number;
}

export interface RateLimitProviderConfig {
  rpm?: number;
  tpm?: number;
}

export interface RouterConfig {
  routes: RouteConfig[];
  retryPolicy: Record<ErrorClass, RetryPolicy>;
  /** Per-provider rate limits; keyed by ProviderName. */
  rateLimit?: Record<string, RateLimitProviderConfig>;
  budgets?: BudgetConfig;
  circuitBreaker?: CircuitBreakerConfig;
  /** Per-call hard cap across the fallback walk. */
  maxFallbackCostUsd?: number;
  /** Behavior when bucket dry. */
  onRateLimit?: 'wait' | 'fallback' | 'fail';
}

// ────────────────────────────────────────────────────────────────────────────
// Caller surface
// ────────────────────────────────────────────────────────────────────────────

export interface InvokeOpts
  extends Omit<LanguageModelInvokeOptions, 'model' | 'messages'> {
  /** Tag selects a route from RouterConfig.routes. */
  tag: string;
  /** Either a raw prompt string or a structured message array. */
  prompt:
    | string
    | Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Escape hatch — pin a specific model id, bypassing tag routing. */
  model?: string;
  runId?: string;
  project?: string;
  user?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Outcome
// ────────────────────────────────────────────────────────────────────────────

export interface RouteAttempt {
  model: string;
  provider: ProviderName | string;
  /** 0-based attempt counter within a single fallback step. */
  attemptIndex: number;
  /** 0 = primary, N = N-th declared fallback. */
  fallbackIndex: number;
  errorClass?: ErrorClass;
  durationMs: number;
  costUsd?: number;
}

export interface RouteOutcome {
  result?: InvokeResult;
  error?: Error;
  attempts: RouteAttempt[];
  totalDurationMs: number;
  totalCostUsd: number;
  budgetRemainingUsd?: number;
}
