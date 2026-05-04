/**
 * Types for Phase 8 — cost ceilings with live override.
 *
 * A CostEntry captures one LLM call's spend, which the CostLedger aggregates
 * into a RunCostSummary. When spend crosses a policy limit the breach state
 * machine (CostBreachHandler) produces BreachState records that the UI and
 * CLI surface to the user.
 *
 * These types are intentionally narrow and side-effect free so that server,
 * CLI, and UI can share them freely.
 */

export type CostStage = 'plan' | 'implement' | 'review' | 'test' | 'ship' | 'other';

export interface CostEntry {
  /** Unique id (ULID-like: `${timestampMs}-${randHex}`). */
  id: string;
  /** Run id this entry belongs to. */
  runId: string;
  /** Project slug. */
  project: string;
  /** Pipeline stage that triggered the call. */
  stage: CostStage;
  /** Optional persona / tool id (for per-agent roll-ups). */
  agent?: string;
  /** Model id, e.g. `claude-opus-4-7`. Used for pricing + `byModel` rollup. */
  model: string;
  /** Input tokens used. */
  tokensIn: number;
  /** Output tokens produced. */
  tokensOut: number;
  /**
   * Phase 1: cache-read tokens (provider returned a cached prefix). Optional
   * because not every provider reports it (Gemini CLI, Ollama). Older NDJSON
   * lines won't have it — readers must default to 0.
   */
  cacheReadTokens?: number;
  /** Cache-write (cache_creation) tokens. Same optional semantics. */
  cacheWriteTokens?: number;
  /** Computed USD cost (to 6 decimal places). */
  usd: number;
  /** ISO 8601 timestamp. */
  at: string;
}

export interface RunCostSummary {
  runId: string;
  project: string;
  totalUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /**
   * Phase 1 KPI: sum(cacheReadTokens) / sum(tokensIn + cacheReadTokens).
   * 0 when no cache events were recorded (legacy entries or providers that
   * don't report cache reads).
   */
  cacheHitRatio: number;
  /** Cumulative cache-read tokens across the run. */
  totalCacheReadTokens: number;
  /** Cumulative cache-write (creation) tokens across the run. */
  totalCacheWriteTokens: number;
  byStage: Record<CostStage, number>;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  startedAt?: string;
  lastAt?: string;
}

/**
 * User decisions on a breach:
 *  - raise:  approve a delta, keep the run going
 *  - reject: tear down the run (checkpoint handled by Phase 9)
 *  - extend: buy more time on the grace window (capped)
 */
export type BreachDecision = 'raise' | 'reject' | 'extend';

export interface BreachState {
  runId: string;
  project: string;
  /** When the breach was first detected. */
  breachedAt: string;
  /** The limit (USD) that was breached. */
  limitUsdAtBreach: number;
  /** Spend (USD) at the moment of breach. */
  currentUsdAtBreach: number;
  /** When the grace window expires if the user hasn't decided. */
  graceEndsAt: string;
  /** Number of extensions the user has applied (capped at 2). */
  extensionsUsed: number;
  /**
   * pending        — waiting on user within grace
   * raised         — user approved additional spend
   * rejected       — user declined; runner should stop
   * auto-resolved  — grace expired without input; policy default applied
   */
  status: 'pending' | 'raised' | 'rejected' | 'auto-resolved';
  decision?: BreachDecision;
  decisionAt?: string;
  /** Amount of USD newly approved (only set for `raise`). */
  deltaUsdApproved?: number;
}
