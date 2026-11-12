/**
 * @deprecated Import from `@esankhan3/anvil-agent-core` directly.
 *
 * Re-export shim — the real implementation moved to `agent-core/src/single-shot.ts`
 * during Phase 5 of the agent-core extract. This file is kept so existing
 * knowledge-core importers (repo-profiler, service-mesh-inferrer, rag-evaluator,
 * indexer) keep working without rewrites.
 */

export {
  runLLM,
  runClaude,
  runGemini,
  isLlmAvailable,
  getLlmModel,
  resetLlmConfig,
  type LLMRunOptions,
  type ClaudeResult,
} from '@esankhan3/anvil-agent-core';
