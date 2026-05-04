/**
 * Type-only surface lifted from the dashboard's pre-Phase-4 `BaseAdapter`
 * abstract class. Used by `LanguageModelBridge` to expose
 * `capabilities` / `markCacheBreakpoint` / `countTokens` to prompt-construction
 * code (dashboard's `prompt-envelope.ts`, `token-util.ts`).
 *
 * The abstract `BaseAdapter` class is gone — `LanguageModelBridge` is the
 * single concrete implementation. These types describe its public surface.
 */

/**
 * Provider-agnostic capability descriptor used by prompt-construction
 * machinery to make caching/output-ceiling/structured-output decisions.
 *
 * Mapped from `agent-core`'s `ProviderCapabilities` via the bridge's
 * internal `mapCapabilities()`.
 */
export interface AdapterCapabilities {
  /**
   * - 'auto'     — provider caches stable prefixes silently (e.g., OpenAI ≥1024 tok).
   * - 'explicit' — caller must place markers (e.g., Anthropic cache_control).
   * - 'none'     — no caching benefit; markers are no-ops.
   */
  promptCache: 'auto' | 'explicit' | 'none';
  /** Whether countTokens uses the model's exact tokenizer or an estimator. */
  countTokens: 'exact' | 'heuristic';
  /** Structured-output support level. */
  structuredOutput: 'strict' | 'tool-shim' | 'best-effort' | 'none';
  /** Cache TTL in seconds when promptCache !== 'none'. Informational only. */
  cacheTtlSeconds?: number;
  /** Adapter knows how to enforce a max-output ceiling. */
  maxOutputTokens: boolean;
}

/**
 * Cost block emitted with the bridge's `result` event. Identical fields to
 * the agent-core `CostInfo` type (which lives in session/types.ts) — kept
 * separate here because the bridge's `result` event payload uses this name
 * historically.
 */
export interface AdapterCostInfo {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  /**
   * Provider's stop reason. Common values:
   *   - 'end_turn' / 'stop'     — natural completion
   *   - 'max_tokens' / 'length' — output ceiling hit (TRUNCATION)
   *   - 'tool_use'              — agent paused for a tool call
   */
  stopReason?: string;
}

/**
 * Structural type describing what `prompt-envelope` and `token-util` need
 * from an adapter. The bridge satisfies it; tests can also stub it.
 */
export interface PromptAwareAdapter {
  readonly capabilities: AdapterCapabilities;
  countTokens(text: string): number;
  markCacheBreakpoint(prompt: string, position: number): string;
}
