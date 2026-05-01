/**
 * @anvil/agent-core — public barrel.
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
export { FallbackAdapter } from './fallback-adapter.js';
export * from './single-shot.js';
export * from './agent/index.js';
export * from './checkpoint/index.js';
export * from './cost.js';
export * from './telemetry/index.js';
export * from './skills/index.js';
export * from './mcp/index.js';
export * from './headless/index.js';
export * from './router/index.js';
export * from './tools/index.js';
export { VERSION } from './version.js';
