/**
 * `@esankhan3/anvil-agent-core` — public type surface.
 *
 * Two interfaces live here, intentionally:
 *
 *   1. `LanguageModel` — the new, forward-looking shape. Vendor-agnostic
 *      streaming/single-shot interface that future code (Phase 5+ of the
 *      agent-core extract) wires against. Yields typed events; analytical
 *      callers drain the stream via the default `invoke()` impl.
 *
 *   2. `ModelAdapter` — the legacy interface inherited from cli/src/providers.
 *      Kept verbatim (same field names, same signatures) so the seven existing
 *      adapters keep compiling unchanged when they move into this package in
 *      Phase 3+4. New code should not import these — they are bridged into
 *      `LanguageModel` via `legacyAdapterToLanguageModel()` (Phase 3).
 *
 * `ProviderName` is shared between the two interfaces and uses the EXISTING
 * values (`'claude' | 'openai' | …`) — see ADR D15. Renaming would cascade
 * through every `ProviderRegistry.get()` site and the model-router dispatcher.
 */

// ────────────────────────────────────────────────────────────────────────────
// Shared identifiers
// ────────────────────────────────────────────────────────────────────────────

export type ProviderName =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'gemini-cli'
  | 'adk'
  | 'opencode';

export type ProviderTier = 'agentic' | 'function-calling' | 'text-only';

export interface ProviderCapabilities {
  tier: ProviderTier;
  streaming: boolean;
  toolUse: boolean;
  fileSystem: boolean;
  shellExecution: boolean;
  sessionResume: boolean;
  /** Whether the provider supports prompt caching (e.g. Anthropic ephemeral cache). */
  promptCaching?: boolean;
  /**
   * Prompt-cache marker semantics:
   *   - 'auto'     — provider caches stable prefixes silently (e.g. OpenAI ≥1024 tok).
   *   - 'explicit' — caller must place markers (e.g. Anthropic cache_control).
   *   - 'none'     — no caching benefit; markers are no-ops.
   * `undefined` means the adapter has not declared a stance — treat as 'none'.
   */
  cache?: 'auto' | 'explicit' | 'none';
  /** Cache TTL in seconds when `cache !== 'none'`. Informational only. */
  cacheTtlSeconds?: number;
  /**
   * Adapter honors `ModelAdapterConfig.maxOutputTokens` and forwards it to the
   * provider. When false, callers may still pass it but the adapter ignores it.
   */
  maxOutputTokens?: boolean;
  /**
   * Structured-output (JSON-schema-constrained generation) support level.
   *   - 'strict'      — provider enforces the schema server-side.
   *   - 'tool-shim'   — caller emulates via tool calls (e.g. Claude's tool-use trick).
   *   - 'best-effort' — prompt-only; provider doesn't constrain output.
   *   - 'none'        — not supported.
   */
  structuredOutput?: 'strict' | 'tool-shim' | 'best-effort' | 'none';
}

// ────────────────────────────────────────────────────────────────────────────
// LanguageModel — new unified interface (Phase 1+)
// ────────────────────────────────────────────────────────────────────────────

export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LanguageModelInvokeOptions {
  model: string;
  messages: LanguageModelMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  /** Index in `messages[]` where a cache breakpoint should be inserted (Anthropic-style). */
  cacheBreakpoint?: number;
  /** Escape hatch for provider-specific knobs (e.g., `topP`, `responseFormat`). */
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'reasoning-delta'; text: string }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      type: 'finish';
      reason: 'end' | 'tool-use' | 'length' | 'error';
      error?: string;
    };

export interface InvokeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface InvokeResult {
  text: string;
  toolCalls: ToolCall[];
  usage: InvokeUsage;
  costUsd: number;
  durationMs: number;
  provider: ProviderName;
  model: string;
  /** Reason the stream finished. Mirrors the final `finish` event. */
  finishReason: 'end' | 'tool-use' | 'length' | 'error';
}

export interface LanguageModel {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;
  supportsModel(modelId: string): boolean;
  /** `[inputPer1M, outputPer1M]` pricing in USD, or `null` if unknown. */
  getModelPricing(modelId: string): [number, number] | null;
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;
  /**
   * Streaming surface — yields events as the provider produces them and
   * RETURNS the assembled `InvokeResult` (cost/usage/finish) on completion,
   * so a streaming consumer (the router's chain walk) gets the same outcome
   * data a single-shot `invoke()` would, without re-running the call.
   */
  invokeStream(opts: LanguageModelInvokeOptions): AsyncGenerator<StreamEvent, InvokeResult>;
  /** Single-shot surface — drains the stream and returns the final block. */
  invoke(opts: LanguageModelInvokeOptions): Promise<InvokeResult>;
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy adapter shape (preserved verbatim from cli/src/providers/types.ts)
// ────────────────────────────────────────────────────────────────────────────
//
// Field names + signatures must remain identical so the seven existing
// adapters (claude / openai / gemini / openrouter / ollama / gemini-cli / adk)
// keep compiling when they move into agent-core in Phase 4. New code should
// prefer `LanguageModel`; the bridge `legacyAdapterToLanguageModel()` is the
// migration path (Phase 3).

export interface ModelAdapterConfig {
  userPrompt: string;
  projectPrompt?: string;
  model: string;
  workingDir: string;
  stage: string;
  persona: string;
  sessionId?: string;
  resume?: boolean;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeout?: number;
  /**
   * Cap on the number of output tokens the provider should emit for this
   * call. Adapters whose `capabilities.maxOutputTokens === true` honor it
   * (set the provider's `max_tokens` knob); others ignore it.
   */
  maxOutputTokens?: number;
  /**
   * Routes the call through the process-local FIFO single-slot executor
   * (`@esankhan3/anvil-agent-core/router/local-executor`). Set true ONLY for local
   * GPU-resident models that cannot co-reside (Qwen 14B / Gemma class).
   * Other adapters ignore this flag. Default false = bypass queue.
   */
  exclusiveSlot?: boolean;
  /**
   * Optional tool executor for adapters that drive their own agentic
   * loop (Ollama, future OpenAI/Gemini agentic paths). When set, the
   * adapter advertises the executor's filtered schemas to the model
   * and feeds back tool results in-loop. Claude CLI ignores it — it
   * ships its own tool runtime.
   */
  toolExecutor?: ToolExecutorLike;
  /**
   * Cap on agentic-loop iterations. Default 32. Adapters that don't
   * loop ignore the field. Hitting the cap surfaces as
   * `stopReason: 'iteration_limit'` in the result.
   */
  maxToolIterations?: number;
  /**
   * Provider-side context-window cap (Ollama `num_ctx`). Bounds VRAM
   * cost of the conversation history. Adapters that don't expose
   * this knob ignore the field.
   */
  contextWindow?: number;
  /**
   * Path to an `mcp.json` config the adapter should forward to its
   * underlying tool runtime. Today only the Claude CLI path consumes
   * this (passes `--mcp-config <path>`); other adapters ignore it.
   * Populated by `defaultAdapterFactory` when a `workspaceDir` is set
   * and an MCP config is discovered. Per AGENT-PROCESS-CONSOLIDATION-
   * ADR §C5.
   */
  mcpConfigPath?: string;
  /**
   * Turn-level durable recorder (v2 ADR §2.5). When supplied by the
   * caller, the adapter splits its LLM invocation into per-turn
   * sub-effects (`assistant-start` / `tool_use:N` / `tool_result:N` /
   * `assistant-end`) recorded against the caller's `EffectRuntime`.
   * When absent, adapters construct a `NullTurnRecorder` internally —
   * structural calls still happen so the code path is the same, but
   * nothing is persisted. Recording is implemented for every adapter
   * except `gemini-cli` (a CLI subprocess with no token-level stream),
   * which always no-ops the recorder.
   */
  turnRecorder?: import('./turn-recorder/index.js').TurnRecorder;
  /**
   * Prefill from a prior model that burned mid-stream (v2 ADR §2.3).
   * When present, the adapter materializes the trailing-assistant +
   * recorded tool-result history into its provider's wire format and
   * continues from the exact character where the prior model stopped.
   */
  prefill?: import('./turn-recorder/index.js').Prefill;
  /**
   * §Tier 2 — COMPLETED prior turns of a stateful session, reconstructed
   * from the durable log. Spliced (materialized into this provider's wire
   * format) BEFORE the new user message so a non-claude session resume
   * re-presents the full conversation instead of starting fresh. Claude
   * uses native `--resume` and is gated out at the bridge. Empty/undefined
   * → unchanged single-turn behavior.
   */
  priorMessages?: import('./turn-recorder/index.js').PrefillTurn[];
}

// `toolExecutor` is structurally typed here to keep `types.ts` free of
// `tools/` imports — the concrete `ToolExecutor` interface lives in
// `tools/types.ts` and matches this shape. Adapters that consume it
// import the concrete type directly.
export interface ToolExecutorLike {
  listSchemas(): ToolSchema[];
  execute(call: ToolCall, ctx: { workingDir: string; abortSignal: AbortSignal }): Promise<{
    content: string;
    isError: boolean;
  }>;
}

export interface ModelAdapterResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  provider: ProviderName;
  model: string;

  // ── Optional telemetry-enrichment fields (added in observability Phase 3).
  //    Adapters that surface these populate them; consumers that don't need
  //    them ignore — every existing caller continues to work unchanged.

  /** Tokens served from a prompt cache (Anthropic cache_read, OpenAI cached_tokens, Gemini cachedContentTokenCount). */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache (Anthropic cache_creation; OpenAI/Gemini do not bill cache writes separately). */
  cacheWriteTokens?: number;
  /** Tokens spent on extended thinking / reasoning blocks (Anthropic ThinkingBlock, OpenAI o-series reasoning, Gemini thoughtsTokenCount). */
  reasoningTokens?: number;
  /** Count of tool_use / function-call invocations in this turn. */
  toolCallCount?: number;
  /**
   * Provider-reported reason the call ended. Common values:
   *   - 'end_turn' / 'stop'     — natural completion
   *   - 'max_tokens' / 'length' — output ceiling hit (truncation)
   *   - 'tool_use'              — paused for a tool call
   * Adapters that don't surface a reason leave it undefined. OpenAI-shape
   * adapters normalize 'length' → 'max_tokens' so callers can detect
   * truncation provider-agnostically.
   */
  stopReason?: string;
}

export interface ModelAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /** Check whether this adapter handles the given model identifier. */
  supportsModel(modelId: string): boolean;

  /** Return [inputPer1M, outputPer1M] pricing, or null if unknown. */
  getModelPricing(modelId: string): [number, number] | null;

  /** Verify the provider CLI / API is reachable and report its version. */
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;

  /** Run agent. Write Anvil Stream Format NDJSON to `output`. */
  run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult>;

  /** Kill running process if applicable. */
  kill?(): void;
}
