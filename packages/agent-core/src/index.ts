/**
 * @esankhan3/anvil-agent-core — public barrel.
 *
 * What lives here today (Phase 1):
 *   - Shared LLM types: `LanguageModel`, `ModelAdapter`, `ProviderName`,
 *     `ProviderTier`, `StreamEvent`, `InvokeResult`, etc.
 *   - VERSION constant.
 *
 * What will land in subsequent phases:
 *   - Phase 2: stream-format types (NDJSON event shapes)
 *   - Phase 3: ProviderRegistry singleton
 *   - Phase 4: 7 provider adapters
 *   - Phase 5: single-shot wrapper (runLLM / runClaude / runGemini)
 *   - Phase 6: agent subprocess machinery (AgentManager, spawn, etc.)
 *   - Phase 7: cost table loader
 */

export * from './types.js';
export * from './stream-format.js';
export * from './registry.js';
export { ClaudeAdapter } from './claude-adapter.js';
export { OpenAIAdapter } from './openai-adapter.js';
export { GeminiAdapter } from './gemini-adapter.js';
export { OpenRouterAdapter } from './openrouter-adapter.js';
export { OllamaAdapter } from './ollama-adapter.js';
export { GeminiCliAdapter } from './gemini-cli-adapter.js';
export { AdkAdapter } from './adk-adapter.js';
export { OpenCodeAdapter } from './opencode-adapter.js';
export { FallbackAdapter } from './fallback-adapter.js';
export * from './single-shot.js';
export * from './agent/index.js';
export * from './checkpoint/index.js';
export * from './cost.js';
export * from './telemetry/index.js';
export * from './skills/index.js';
export * from './mcp/index.js';
export * from './router/index.js';
export * from './tools/index.js';
export {
  setLivenessTtlMs,
  getLivenessTtlMs,
  isProviderAlive,
  pickAliveModelFromChain,
  pickAliveModelFromChainSync,
  prefetchLiveness,
  _resetLivenessCache,
} from './provider-liveness.js';
export {
  DEFAULT_SPEC,
  getModelSpec,
  getContextWindow,
  getMaxOutput,
} from './model-catalog.js';
export type { ModelSpec } from './model-catalog.js';
export {
  resolveModelByTier,
  setDiscoveryResult,
  invalidateResolverCache,
} from './model-tier-resolver.js';
export type {
  ResolverTier,
  ResolverCapability,
  ResolverModelWeight,
  ResolverModel,
  ResolverDiscoveryResult,
} from './model-tier-resolver.js';
// NOTE: the resolver's deprecated `ModelTier` alias is intentionally
// NOT re-exported here to avoid colliding with `router/model-registry.ts`'s
// `ModelTier` (different vocabulary). Reach the alias via the subpath
// import `@esankhan3/anvil-agent-core/model-tier-resolver.js` if needed.
export {
  getFetchPool,
  recycleFetchPoolOnFailure,
  getPoolMetrics,
} from './fetch-pool.js';
export type {
  ProviderId as FetchPoolProviderId,
  PoolMetrics as FetchPoolMetrics,
} from './fetch-pool.js';
export {
  TurnRecorder,
  createNullTurnRecorder,
  createNullEffectRuntime,
  createNullPartialSink,
} from './turn-recorder/index.js';
export type {
  AssistantPartial,
  AssistantStartRequest,
  AssistantTurn,
  EffectRuntimeLike,
  EffectInvokeOptions,
  NeutralToolResult,
  PartialReason,
  PartialSink,
  Prefill,
  PrefillToolUse,
  PrefillTurn,
  Provenance,
  ProvenanceSegment,
  RecordedToolUse,
  TurnRecorderDeps,
  TurnTokenUsage,
} from './turn-recorder/types.js';
export { contentHashFromArgs } from './turn-recorder/hash.js';
export { stripForTarget } from './prefill/strip.js';
export type { StripContext } from './prefill/strip.js';
export { translateToolResult } from './prefill/translate.js';
export type { TranslatedToolResult } from './prefill/translate.js';
export {
  truncatePrefillForBudget,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MARGIN_TOKENS,
} from './prefill/truncate.js';
export type { TruncatePrefillArgs } from './prefill/truncate.js';
export { VERSION } from './version.js';
