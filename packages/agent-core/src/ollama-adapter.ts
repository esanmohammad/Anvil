/**
 * Ollama adapter — HTTP API for local Ollama server, no npm dependencies.
 *
 * Base URL: OLLAMA_HOST env var or http://localhost:11434
 * Streaming: NDJSON (not SSE) from POST /api/chat
 *
 * Two modes, picked at runtime by the presence of `config.toolExecutor`:
 *
 *   1. Single-shot chat — no tool executor. Drains one /api/chat
 *      response, emits text + result. Backwards-compatible with every
 *      caller that existed before agentic support landed.
 *
 *   2. Agentic loop — tool executor present. Each turn the adapter
 *      sends `tools: [...]` (OpenAI-compatible JSON Schema), parses
 *      `message.tool_calls` from the response, executes each call via
 *      the executor, appends the assistant + tool messages to history,
 *      and re-POSTs. Loops until the model returns no tool_calls or
 *      the `maxToolIterations` cap fires.
 *
 * Capabilities flip to `tier: 'agentic'` because the adapter now drives
 * a full agentic loop. Stage-policy.yaml's build/validate/ship preferences
 * for `local` are real — the adapter can hold its end of those stages.
 */

import { randomUUID } from 'node:crypto';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ToolCall,
  ToolExecutorLike,
  ToolSchema,
} from './types.js';
import { emitContent, emitResult, emitToolResult, emitToolUse } from './stream-format.js';
import { LocalExecutor, localExecutor } from './router/local-executor.js';

const DEFAULT_MAX_ITERATIONS = 32;
const DEFAULT_CONTEXT_WINDOW = 16_384;

function getBaseUrl(): string {
  return (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
}

// ───────────────────────────────────────────────────────────────────────
// Wire shapes — Ollama /api/chat NDJSON
// ───────────────────────────────────────────────────────────────────────

interface OllamaChatChunk {
  model?: string;
  done?: boolean;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
}

// ───────────────────────────────────────────────────────────────────────
// Adapter
// ───────────────────────────────────────────────────────────────────────

export class OllamaAdapter implements ModelAdapter {
  readonly provider = 'ollama' as const;

  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: false,
    cache: 'none',
    structuredOutput: 'best-effort',
    maxOutputTokens: false,
  };

  private abortController: AbortController | null = null;

  /**
   * @param executor — Single-slot FIFO queue used when a call sets
   * `config.exclusiveSlot === true`. Defaults to the process-wide
   * singleton; tests inject a fresh instance for isolation.
   */
  constructor(private readonly executor: LocalExecutor = localExecutor) {}

  supportsModel(_modelId: string): boolean {
    // Only used when explicitly configured; auto-detection is via registry rules.
    return false;
  }

  getModelPricing(_modelId: string): [number, number] | null {
    return [0, 0]; // local = free
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const baseUrl = getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
      if (res.ok) return { available: true };
      return { available: false, error: `Ollama returned ${res.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, error: `Cannot reach Ollama at ${baseUrl}: ${msg}` };
    }
  }

  kill(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async run(
    config: ModelAdapterConfig,
    output: NodeJS.WritableStream,
  ): Promise<ModelAdapterResult> {
    if (config.exclusiveSlot) {
      return this.executor.withModel(config.model, () => this.runInner(config, output));
    }
    return this.runInner(config, output);
  }

  private async runInner(
    config: ModelAdapterConfig,
    output: NodeJS.WritableStream,
  ): Promise<ModelAdapterResult> {
    this.abortController = new AbortController();
    const startMs = Date.now();

    const messages: ChatMessage[] = [];
    if (config.projectPrompt) messages.push({ role: 'system', content: config.projectPrompt });
    messages.push({ role: 'user', content: config.userPrompt });

    const tools = config.toolExecutor ? mapSchemasToOllama(config.toolExecutor.listSchemas()) : undefined;
    const numCtx = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const maxIter = config.maxToolIterations ?? DEFAULT_MAX_ITERATIONS;

    let aggregatedText = '';
    let totalIn = 0;
    let totalOut = 0;
    let totalDurMs = 0;
    let stopReason: string | undefined;

    try {
      for (let iter = 0; iter < maxIter; iter++) {
        const turn = await this.runOneTurn(messages, tools, numCtx, config, output);
        aggregatedText += turn.text;
        totalIn += turn.inputTokens;
        totalOut += turn.outputTokens;
        totalDurMs += turn.durationMs;

        if (turn.toolCalls.length === 0 || !config.toolExecutor) {
          stopReason = turn.toolCalls.length === 0 ? 'end_turn' : 'tools_unsupported';
          break;
        }

        // Append the assistant's tool-call turn to history so the model
        // sees its own request when we re-prompt with results.
        messages.push({
          role: 'assistant',
          content: turn.text,
          tool_calls: turn.toolCalls,
        });

        // Execute every tool call. Sequential — parallel exec via the
        // builtin executor is safe today (each tool is independent),
        // but bash/edit ordering matters when the model chains them,
        // so we serialize.
        for (const toolCall of turn.toolCalls) {
          const callId = randomUUID();
          const args = normalizeArgs(toolCall.function.arguments);
          const call: ToolCall = { id: callId, name: toolCall.function.name, arguments: args };
          emitToolUse(output, call.name, args, callId);

          const result = await invokeTool(config.toolExecutor, call, config.workingDir, this.abortController.signal);
          emitToolResult(output, { toolUseId: callId, content: result.content, isError: result.isError });

          messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: callId,
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

    const durationMs = totalDurMs > 0 ? totalDurMs : Date.now() - startMs;

    emitResult(output, {
      text: aggregatedText,
      costUsd: 0,
      inputTokens: totalIn,
      outputTokens: totalOut,
      durationMs,
    });

    return {
      output: aggregatedText,
      inputTokens: totalIn,
      outputTokens: totalOut,
      costUsd: 0,
      durationMs,
      provider: 'ollama',
      model: config.model,
      stopReason,
      toolCallCount: countToolCalls(messages),
    };
  }

  /**
   * One round-trip with Ollama: send messages + tools, drain the NDJSON
   * stream, return the assistant's text accumulator + any tool_calls
   * the model emitted in the final chunk.
   */
  private async runOneTurn(
    messages: ChatMessage[],
    tools: OllamaToolDef[] | undefined,
    numCtx: number,
    config: ModelAdapterConfig,
    output: NodeJS.WritableStream,
  ): Promise<{
    text: string;
    toolCalls: OllamaToolCall[];
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }> {
    const baseUrl = getBaseUrl();
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
      options: { num_ctx: numCtx },
    };
    if (tools && tools.length > 0) body.tools = tools;
    if (typeof config.maxOutputTokens === 'number' && config.maxOutputTokens > 0) {
      (body.options as Record<string, unknown>).num_predict = config.maxOutputTokens;
    }

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController!.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Ollama API ${response.status}: ${errBody}`);
    }
    if (!response.body) throw new Error('Ollama API returned no response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls: OllamaToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk: OllamaChatChunk;
        try {
          chunk = JSON.parse(trimmed);
        } catch {
          continue;
        }

        const msg = chunk.message;
        if (msg?.content) {
          text += msg.content;
          emitContent(output, msg.content);
        }
        if (msg?.tool_calls && msg.tool_calls.length > 0) {
          toolCalls.push(...msg.tool_calls);
        }
        if (chunk.done === true) {
          if (typeof chunk.prompt_eval_count === 'number') inputTokens = chunk.prompt_eval_count;
          if (typeof chunk.eval_count === 'number') outputTokens = chunk.eval_count;
          if (typeof chunk.total_duration === 'number') durationMs = chunk.total_duration / 1_000_000;
        }
      }
    }

    return { text, toolCalls, inputTokens, outputTokens, durationMs };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function mapSchemasToOllama(schemas: ToolSchema[]): OllamaToolDef[] {
  return schemas.map((s) => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: s.inputSchema,
    },
  }));
}

function normalizeArgs(args: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof args === 'object' && args !== null) return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { _raw: args };
    }
  }
  return {};
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
