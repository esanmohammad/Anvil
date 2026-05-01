/**
 * OpenRouter adapter — agentic OpenAI-compatible client.
 *
 * OpenRouter aggregates many providers (Anthropic / Google / Meta / OpenAI…)
 * behind one OpenAI-compatible API. Models advertise via the `provider/model`
 * id format (e.g. `anthropic/claude-sonnet-4-6`).
 *
 * Two modes, picked at runtime by the presence of `config.toolExecutor`:
 *
 *   1. Single-shot chat — no executor. Drains one /v1/chat/completions
 *      response, emits text + result. Backwards-compatible with every
 *      caller that existed before agentic support landed.
 *
 *   2. Agentic loop — executor present. Each turn the adapter sends
 *      `tools: [...]` (OpenAI function-calling shape), reassembles
 *      `tool_calls` from streaming deltas (OpenAI streams arguments
 *      piecemeal, indexed), executes via the executor, appends the
 *      assistant + tool messages to history, and re-POSTs. Loops up
 *      to maxToolIterations (default 32).
 *
 * Capabilities flip to `tier: 'agentic'` because the adapter now drives
 * a full agentic loop, same as OllamaAdapter. Stage-policy.yaml's
 * build/validate/ship can route here when ANVIL_LLM_PROVIDER=openrouter
 * or via per-stage models.yaml entries.
 */

import { randomUUID } from 'node:crypto';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
  ToolCall,
  ToolExecutorLike,
  ToolSchema,
} from './types.js';
import { emitContent, emitResult, emitToolResult, emitToolUse } from './stream-format.js';

const DEFAULT_MAX_ITERATIONS = 32;

// ───────────────────────────────────────────────────────────────────────
// Pricing fallbacks for well-known OpenRouter slugs. OpenRouter itself
// returns `usage.cost` in the response when available — that wins. This
// table is just a fallback for older API versions that don't report it.
// Price = [inputPer1MTokens, outputPer1MTokens]
// ───────────────────────────────────────────────────────────────────────

const OPENROUTER_PRICING: Record<string, [number, number]> = {
  // OpenAI
  'openai/gpt-4o':                          [2.5, 10.0],
  'openai/gpt-4o-mini':                     [0.15, 0.60],
  'openai/gpt-4-turbo':                     [10.0, 30.0],
  'openai/o1':                              [15.0, 60.0],
  'openai/o3':                              [10.0, 40.0],
  'openai/o3-mini':                         [1.1, 4.4],
  // Anthropic — current generation
  'anthropic/claude-haiku-4-5':             [1.0, 5.0],
  'anthropic/claude-sonnet-4-6':            [3.0, 15.0],
  'anthropic/claude-sonnet-4-7':            [3.0, 15.0],
  'anthropic/claude-opus-4-7':              [15.0, 75.0],
  // Google
  'google/gemini-2.5-flash':                [0.30, 2.50],
  'google/gemini-2.5-pro':                  [1.25, 10.0],
  // Meta
  'meta-llama/llama-3.3-70b-instruct':      [0.59, 0.79],
  // DeepSeek
  'deepseek/deepseek-r1':                   [0.55, 2.19],
};

// ───────────────────────────────────────────────────────────────────────
// Wire shapes — OpenAI-compatible SSE
// ───────────────────────────────────────────────────────────────────────

interface ChatCompletionChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** OpenRouter-specific: actual USD cost for this call. */
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface AccumulatedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AccumulatedToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ───────────────────────────────────────────────────────────────────────
// Adapter
// ───────────────────────────────────────────────────────────────────────

export class OpenRouterAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'openrouter';

  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: false,
    promptCaching: true,            // OpenRouter passes through provider caching
    cache: 'auto',
    cacheTtlSeconds: 600,
    structuredOutput: 'strict',
    maxOutputTokens: true,
  };

  private abortController: AbortController | null = null;

  // -- Configuration --------------------------------------------------------

  protected getApiKey(): string | undefined {
    return process.env.OPENROUTER_API_KEY;
  }

  protected getBaseUrl(): string {
    return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  }

  protected getExtraHeaders(): Record<string, string> {
    return {
      // OpenRouter-recommended attribution headers — surface in their
      // analytics and rankings dashboards.
      'HTTP-Referer': 'https://anvil.dev',
      'X-Title': 'Anvil',
    };
  }

  // -- ModelAdapter interface -----------------------------------------------

  supportsModel(modelId: string): boolean {
    // OpenRouter slugs are `provider/model`. Catches Anthropic, OpenAI,
    // Google, Meta, etc. without ambiguity vs other adapters.
    return modelId.includes('/');
  }

  getModelPricing(modelId: string): [number, number] | null {
    return OPENROUTER_PRICING[modelId] ?? null;
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const key = this.getApiKey();
    if (!key) return { available: false, error: 'OPENROUTER_API_KEY is not set' };
    return { available: true };
  }

  kill(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

    this.abortController = new AbortController();
    const startMs = Date.now();

    const messages: ChatMessage[] = [];
    if (config.projectPrompt) messages.push({ role: 'system', content: config.projectPrompt });
    messages.push({ role: 'user', content: config.userPrompt });

    const tools = config.toolExecutor ? mapSchemasToOpenAI(config.toolExecutor.listSchemas()) : undefined;
    const maxIter = config.maxToolIterations ?? DEFAULT_MAX_ITERATIONS;

    let aggregatedText = '';
    let totalIn = 0;
    let totalOut = 0;
    let totalCachedReadTokens = 0;
    let totalReasoningTokens = 0;
    let openRouterCost = 0;
    let stopReason: string | undefined;
    let providerFinishReason: string | undefined;

    try {
      for (let iter = 0; iter < maxIter; iter++) {
        const turn = await this.runOneTurn(apiKey, messages, tools, config, output);
        aggregatedText += turn.text;
        totalIn += turn.inputTokens;
        totalOut += turn.outputTokens;
        totalCachedReadTokens += turn.cachedReadTokens;
        totalReasoningTokens += turn.reasoningTokens;
        openRouterCost += turn.cost;
        if (turn.finishReason) providerFinishReason = turn.finishReason;

        if (turn.toolCalls.length === 0 || !config.toolExecutor) {
          stopReason = turn.toolCalls.length === 0 ? 'end_turn' : 'tools_unsupported';
          break;
        }

        // Append assistant turn to history so the model sees its own
        // tool_calls when we re-prompt with results.
        messages.push({
          role: 'assistant',
          content: turn.text || null,
          tool_calls: turn.toolCalls,
        });

        for (const tc of turn.toolCalls) {
          const args = parseArgs(tc.function.arguments);
          const call: ToolCall = { id: tc.id, name: tc.function.name, arguments: args };
          emitToolUse(output, call.name, args, tc.id);

          const result = await invokeTool(config.toolExecutor, call, config.workingDir, this.abortController.signal);
          emitToolResult(output, { toolUseId: tc.id, content: result.content, isError: result.isError });

          messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: tc.id,
          });
        }

        if (this.abortController.signal.aborted) {
          stopReason = 'aborted';
          break;
        }
      }
      if (stopReason === undefined) stopReason = 'iteration_limit';
    } finally {
      this.abortController = null;
    }

    const durationMs = Date.now() - startMs;

    // Cost: prefer OpenRouter's reported cost (covers all providers it
    // knows). Fall back to our pricing table when absent. When the table
    // also misses, costUsd = 0 and downstream telemetry will catch the
    // gap via the central cost table in cost.ts.
    let costUsd = openRouterCost;
    if (costUsd === 0) {
      const pricing = this.getModelPricing(config.model);
      if (pricing) {
        costUsd = (totalIn / 1_000_000) * pricing[0] + (totalOut / 1_000_000) * pricing[1];
      }
    }

    // Normalize length finish-reason like OpenAIAdapter does so callers
    // can detect truncation provider-agnostically.
    const normalizedStopReason = stopReason === 'end_turn' && providerFinishReason === 'length'
      ? 'max_tokens'
      : stopReason;

    emitResult(output, {
      text: aggregatedText,
      costUsd,
      inputTokens: totalIn,
      outputTokens: totalOut,
      durationMs,
      cacheReadTokens: totalCachedReadTokens,
    });

    return {
      output: aggregatedText,
      inputTokens: totalIn,
      outputTokens: totalOut,
      costUsd,
      durationMs,
      provider: this.provider,
      model: config.model,
      stopReason: normalizedStopReason,
      cacheReadTokens: totalCachedReadTokens || undefined,
      reasoningTokens: totalReasoningTokens || undefined,
      toolCallCount: countToolCalls(messages),
    };
  }

  // -- Per-turn round-trip --------------------------------------------------

  private async runOneTurn(
    apiKey: string,
    messages: ChatMessage[],
    tools: OpenAIToolDef[] | undefined,
    config: ModelAdapterConfig,
    output: NodeJS.WritableStream,
  ): Promise<{
    text: string;
    toolCalls: AccumulatedToolCall[];
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    reasoningTokens: number;
    cost: number;
    finishReason: string | undefined;
  }> {
    const url = `${this.getBaseUrl()}/chat/completions`;
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (typeof config.maxOutputTokens === 'number' && config.maxOutputTokens > 0) {
      body.max_tokens = config.maxOutputTokens;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...this.getExtraHeaders(),
      },
      body: JSON.stringify(body),
      signal: this.abortController!.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenRouter API ${response.status}: ${errBody}`);
    }
    if (!response.body) throw new Error('OpenRouter API returned no response body');

    return this.consumeSSE(response, output);
  }

  /**
   * Drain the SSE stream. Reassembles `tool_calls` from streamed deltas
   * (OpenAI sends arguments as multiple chunks indexed by tool-call
   * `index`). Emits text deltas to the output stream as they arrive.
   */
  private async consumeSSE(
    response: Response,
    output: NodeJS.WritableStream,
  ): Promise<{
    text: string;
    toolCalls: AccumulatedToolCall[];
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    reasoningTokens: number;
    cost: number;
    finishReason: string | undefined;
  }> {
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedReadTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    let finishReason: string | undefined;
    const toolCallsByIndex = new Map<number, AccumulatedToolCall>();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;          // empty / SSE comment
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          text += delta.content;
          emitContent(output, delta.content);
        }
        if (delta?.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const existing = toolCallsByIndex.get(tcDelta.index);
            if (!existing) {
              toolCallsByIndex.set(tcDelta.index, {
                id: tcDelta.id ?? randomUUID(),
                type: 'function',
                function: {
                  name: tcDelta.function?.name ?? '',
                  arguments: tcDelta.function?.arguments ?? '',
                },
              });
            } else {
              if (tcDelta.id) existing.id = tcDelta.id;
              if (tcDelta.function?.name) existing.function.name += tcDelta.function.name;
              if (tcDelta.function?.arguments) existing.function.arguments += tcDelta.function.arguments;
            }
          }
        }
        if (typeof choice?.finish_reason === 'string') {
          finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          cachedReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedReadTokens;
          reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? reasoningTokens;
          if (typeof chunk.usage.cost === 'number') cost = chunk.usage.cost;
        }
      }
    }

    // Sort tool_calls by their original index so loop dispatch order
    // mirrors what the model intended.
    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);

    return {
      text,
      toolCalls,
      inputTokens,
      outputTokens,
      cachedReadTokens,
      reasoningTokens,
      cost,
      finishReason,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function mapSchemasToOpenAI(schemas: ToolSchema[]): OpenAIToolDef[] {
  return schemas.map((s) => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: s.inputSchema,
    },
  }));
}

/**
 * OpenAI streams `tool_calls.arguments` as a JSON-encoded string built
 * up across many deltas. Parse it, fall back to `{ _raw }` when the
 * model emitted malformed JSON so the executor still gets a chance to
 * react.
 */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

async function invokeTool(
  executor: ToolExecutorLike,
  call: ToolCall,
  workingDir: string,
  abortSignal: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  try {
    return await executor.execute(call, { workingDir, abortSignal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Tool execution threw: ${msg}`, isError: true };
  }
}

function countToolCalls(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) n += m.tool_calls.length;
  }
  return n;
}
