/**
 * GenAI semantic-convention attribute keys.
 *
 * Mirrors the OpenTelemetry GenAI SIG spec
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/llm-spans/) plus
 * Anvil-specific extensions for cost USD, cache tokens, and tool argument
 * size. Anvil-extension attributes follow the same `gen_ai.*` namespace so
 * backends without LLM-specific UIs still render them as plain attributes.
 */

export const GenAi = {
  // -- Spec --------------------------------------------------------------
  SYSTEM: 'gen_ai.system',
  REQUEST_MODEL: 'gen_ai.request.model',
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  RESPONSE_MODEL: 'gen_ai.response.model',
  RESPONSE_ID: 'gen_ai.response.id',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  TOOL_NAME: 'gen_ai.tool.name',

  // -- Anvil extensions --------------------------------------------------
  USAGE_CACHE_READ_TOKENS: 'gen_ai.usage.cache_read_tokens',
  USAGE_CACHE_WRITE_TOKENS: 'gen_ai.usage.cache_write_tokens',
  USAGE_CACHE_HIT_RATIO: 'gen_ai.usage.cache_hit_ratio',
  USAGE_COST_USD: 'gen_ai.usage.cost_usd',
  USAGE_COST_INPUT_USD: 'gen_ai.usage.cost_input_usd',
  USAGE_COST_OUTPUT_USD: 'gen_ai.usage.cost_output_usd',
  USAGE_COST_CACHE_READ_USD: 'gen_ai.usage.cost_cache_read_usd',
  USAGE_COST_CACHE_WRITE_USD: 'gen_ai.usage.cost_cache_write_usd',
  TOOL_ARGUMENTS_SIZE: 'gen_ai.tool.arguments_size_bytes',
  REASONING_TOKENS: 'gen_ai.reasoning.tokens',
  REASONING_TEXT: 'gen_ai.reasoning.text',
  MESSAGES_COUNT: 'gen_ai.messages.count',
  TOOLS_COUNT: 'gen_ai.tools.count',
  PROMPT: 'gen_ai.prompt',
  COMPLETION: 'gen_ai.completion',
} as const;

export type GenAiAttribute = (typeof GenAi)[keyof typeof GenAi];
