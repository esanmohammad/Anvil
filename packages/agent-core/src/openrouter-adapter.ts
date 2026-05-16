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

/**
 * Re-export the shared `UpstreamError` so existing imports
 * (`import { UpstreamError } from '@esankhan3/anvil-agent-core/openrouter-adapter'`)
 * keep working. The class itself lives in `upstream-error.ts` and is
 * shared by every adapter that talks to a remote provider.
 */
export { UpstreamError } from './upstream-error.js';
import { UpstreamError as _UpstreamError } from './upstream-error.js';

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
      /**
       * Thinking-model reasoning trace, OpenRouter-normalized field
       * name. Streamed in pieces. Models like DeepSeek V4 and Kimi K2
       * REQUIRE the structured `reasoning_details` to be echoed back
       * in the next turn's assistant message; otherwise the upstream
       * rejects with "reasoning_content is missing in assistant tool
       * call".
       */
      reasoning?: string;
      reasoning_details?: ReasoningDetail[];
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

interface ReasoningDetail {
  type: string;          // e.g. 'reasoning.text'
  text?: string;
  format?: string;       // e.g. 'unknown'
  index?: number;
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
  /** Required for thinking models when continuing the conversation.
   *  OpenRouter accepts either the string form OR the structured
   *  reasoning_details array — sending both maximises upstream
   *  compatibility (some providers want one, some the other). */
  reasoning?: string;
  reasoning_details?: ReasoningDetail[];
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

  /**
   * In-flight AbortControllers — one per concurrent run() invocation.
   * The adapter is a singleton (registered once with ProviderRegistry),
   * but per-repo stages run multiple repos in parallel against it. A
   * single instance-level field would let one call's `finally` block
   * null out the controller while another call is still mid-fetch,
   * causing "Cannot read properties of null (reading 'signal')". The
   * Set lets every concurrent call own its own AbortController without
   * trampling, and `kill()` aborts ALL of them (matches legacy
   * "stop the run" semantics).
   */
  private activeControllers = new Set<AbortController>();

  // -- Configuration --------------------------------------------------------

  protected getApiKey(): string | undefined {
    return process.env.OPENROUTER_API_KEY;
  }

  protected getBaseUrl(): string {
    return (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  }

  /**
   * Whether to strip `reasoning` / `reasoning_details` fields from
   * the echoed assistant turn when re-prompting after tool results.
   *
   * Default `false` — OpenRouter requires the reasoning trace echoed
   * back for thinking models (DeepSeek V4, Kimi K2.x, GLM thinking)
   * or it 400s with "reasoning_content is missing in assistant tool
   * call".
   *
   * Subclasses override to `true` when their upstream proxy is strict
   * about extra sibling fields on the assistant message (e.g. OpenCode
   * for Kimi K2.6, where the proxy rejects both `reasoning` AND
   * `reasoning_details` as "Extra inputs not permitted").
   */
  protected stripReasoningEcho(): boolean {
    return false;
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
    for (const ac of this.activeControllers) {
      try { ac.abort(); } catch { /* already aborted */ }
    }
    this.activeControllers.clear();
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

    const abortController = new AbortController();
    this.activeControllers.add(abortController);
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
        const turn = await this.runOneTurn(apiKey, messages, tools, config, output, abortController.signal);
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
        // tool_calls when we re-prompt with results. Thinking models
        // (DeepSeek V4, Kimi K2, GLM thinking variants…) require the
        // reasoning trace echoed back via OpenRouter — without it they
        // 400 with "reasoning_content is missing in assistant tool
        // call".
        //
        // Per OpenRouter docs (openrouter.ai/docs/guides/best-practices
        // /reasoning-tokens), the model returns EITHER `reasoning`
        // (string) OR `reasoning_details` (array) — not both. Preserve
        // whichever was returned, "exactly as returned." Prefer the
        // structured `reasoning_details` since it's the canonical shape
        // for tool-calling.
        //
        // Some OpenAI-compatible proxies (OpenCode for Kimi K2.6) reject
        // reasoning fields entirely — they're strict on unknown sibling
        // fields. Subclasses override `stripReasoningEcho()` to return
        // true and skip the echo. See anomalyco/opencode #14716.
        messages.push({
          role: 'assistant',
          content: turn.text || null,
          ...(this.stripReasoningEcho()
            ? {}
            : turn.reasoningDetails.length > 0
              ? { reasoning_details: turn.reasoningDetails }
              : (turn.reasoning ? { reasoning: turn.reasoning } : {})),
          tool_calls: turn.toolCalls,
        });

        for (const tc of turn.toolCalls) {
          const args = parseArgs(tc.function.arguments);
          const call: ToolCall = { id: tc.id, name: tc.function.name, arguments: args };
          emitToolUse(output, call.name, args, tc.id);

          const result = await invokeTool(config.toolExecutor, call, config.workingDir, abortController.signal);
          emitToolResult(output, { toolUseId: tc.id, content: result.content, isError: result.isError });

          messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: tc.id,
          });
        }

        if (abortController.signal.aborted) {
          stopReason = 'aborted';
          break;
        }
      }
      if (stopReason === undefined) stopReason = 'iteration_limit';
    } finally {
      this.activeControllers.delete(abortController);
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

    // Silent-empty defense: if the agentic loop terminated without ever
    // appending final text content (model spent its turns on tool_use /
    // reasoning blocks but never emitted assistant text), surface as a
    // retryable upstream error so the dashboard's chain-fallback walks
    // to the next chain entry instead of writing a 0-byte artifact.
    //
    // Exclude `iteration_limit` — that's a deliberate caller-side cap,
    // not a model failure. The model did what it was asked; bubbling
    // this up as retryable would needlessly burn the model.
    // downstream. Mirrors the claude-adapter contract.
    if (!aggregatedText.trim() && stopReason !== 'aborted' && stopReason !== 'iteration_limit') {
      throw new _UpstreamError(
        503,
        `${this.provider} model "${config.model}" returned empty final text (stopReason=${stopReason}, outputTokens=${totalOut}, toolCalls=${countToolCalls(messages)})`,
        { provider: this.provider, retryable: true },
      );
    }

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
    signal: AbortSignal,
  ): Promise<{
    text: string;
    reasoning: string;
    reasoningDetails: ReasoningDetail[];
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

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...this.getExtraHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Network-layer failures (DNS, connection refused, TLS handshake,
      // network unreachable) surface as raw `TypeError: fetch failed`
      // here — never reach the `!response.ok` branch below. Wrap as a
      // retryable UpstreamError so the chain walker burns this model
      // and tries the next chain entry instead of bubbling unwrapped.
      // Honor caller-driven aborts (signal.aborted) — those are not
      // retryable; the run was intentionally cancelled.
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new _UpstreamError(0, `fetch failed: ${msg}`, { provider: this.provider, retryable: true });
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new _UpstreamError(response.status, errBody, { provider: this.provider });
    }
    if (!response.body) throw new _UpstreamError(0, `${this.provider} returned no response body`, { provider: this.provider });

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
    reasoning: string;
    reasoningDetails: ReasoningDetail[];
    toolCalls: AccumulatedToolCall[];
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    reasoningTokens: number;
    cost: number;
    finishReason: string | undefined;
  }> {
    let text = '';
    let reasoning = '';
    const reasoningDetails: ReasoningDetail[] = [];
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
    // Buffer text deltas and flush at natural breaks (newline OR every
    // ~80 chars). Without this, OpenAI-compatible streams that emit
    // one token per chunk produce one activity card per word in the
    // dashboard — every "passes", "(", "all", ")" gets its own row.
    // Flushing on `\n` or threshold gives readable line-sized chunks.
    let pendingText = '';
    const FLUSH_THRESHOLD = 80;
    const flushPending = () => {
      if (pendingText.length === 0) return;
      emitContent(output, pendingText);
      pendingText = '';
    };

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
          pendingText += delta.content;
          // Split the accumulated buffer on newlines so the flush is
          // always anchored at a natural line boundary; emit each
          // complete line, retain the trailing partial line.
          while (pendingText.includes('\n')) {
            const nl = pendingText.indexOf('\n');
            const line = pendingText.slice(0, nl + 1);
            emitContent(output, line);
            pendingText = pendingText.slice(nl + 1);
          }
          // No newline yet but buffer is large — flush so very long
          // single-line outputs (e.g. one paragraph) don't sit
          // pending until the very end of the stream.
          if (pendingText.length >= FLUSH_THRESHOLD) {
            emitContent(output, pendingText);
            pendingText = '';
          }
        }
        if (delta?.reasoning) {
          // Accumulate but don't stream to user — reasoning is for the
          // upstream's continuation, not for the dashboard activity log.
          reasoning += delta.reasoning;
        }
        if (delta?.reasoning_details && Array.isArray(delta.reasoning_details)) {
          for (const rd of delta.reasoning_details) {
            // Merge by index — like tool_calls, reasoning_details are
            // streamed piecewise and grouped by `index`.
            const idx = typeof rd.index === 'number' ? rd.index : reasoningDetails.length;
            const existing = reasoningDetails[idx];
            if (!existing) {
              reasoningDetails[idx] = { ...rd, text: rd.text ?? '' };
            } else if (rd.text) {
              existing.text = (existing.text ?? '') + rd.text;
            }
          }
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

    // Flush any trailing content that didn't end on a newline so the
    // last line of the response surfaces in the activity log.
    flushPending();

    // Sort tool_calls by their original index so loop dispatch order
    // mirrors what the model intended.
    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);

    return {
      text,
      reasoning,
      reasoningDetails: reasoningDetails.filter(Boolean),
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
