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
import { UpstreamError } from './upstream-error.js';
import { getFetchPool, recycleFetchPoolOnFailure } from './fetch-pool.js';
import { TurnRecorder, createNullTurnRecorder } from './turn-recorder/index.js';
import { contentHashFromArgs } from './turn-recorder/hash.js';
import type { NeutralToolResult, Provenance, TurnTokenUsage } from './turn-recorder/types.js';

const DEFAULT_MAX_ITERATIONS = 32;
const DEFAULT_CONTEXT_WINDOW = 16_384;
/**
 * Crude tokens-per-byte heuristic. Real tokenizer counts vary by model
 * but for the purposes of OVERFLOW DETECTION (i.e. "are we about to
 * blow num_ctx?") a 4-bytes-per-token approximation is conservative
 * enough — we trim before we'd hit the wall, never after.
 */
const BYTES_PER_TOKEN = 4;
/**
 * Soft trim threshold — when accumulated history reaches this fraction
 * of num_ctx, drop oldest tool_result blocks. Keeps a safety margin so
 * the prompt still has room to grow within one turn.
 */
const SOFT_TRIM_RATIO = 0.85;

/** Thrown when the conversation history can't be trimmed below num_ctx
 *  (e.g. one tool result alone exceeds the window). The dashboard
 *  resolver catches this and re-runs the stage with an escalation chain
 *  that skips local. */
export class ContextExhaustedError extends Error {
  readonly model: string;
  readonly numCtx: number;
  readonly historyTokens: number;
  constructor(model: string, numCtx: number, historyTokens: number) {
    super(
      `Conversation history (${historyTokens} tokens) exceeds num_ctx=${numCtx} for model "${model}" ` +
      `even after trimming. Escalate to a model with a larger context window.`,
    );
    this.name = 'ContextExhaustedError';
    this.model = model;
    this.numCtx = numCtx;
    this.historyTokens = historyTokens;
  }
}

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

  /**
   * In-flight AbortControllers — one per concurrent run() invocation.
   * The adapter is a singleton, but per-repo stages (build/validate/
   * specs/tasks) run multiple repos in parallel against it. A single
   * instance-level field would let one call's `finally` block null out
   * the controller while another is still mid-fetch, causing
   * "Cannot read properties of null (reading 'signal')". The Set lets
   * concurrent calls each own their own controller; kill() aborts all.
   */
  private activeControllers = new Set<AbortController>();

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
      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'GET',
        // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
        dispatcher: getFetchPool('ollama'),
      });
      if (res.ok) return { available: true };
      return { available: false, error: `Ollama returned ${res.status}` };
    } catch (err: unknown) {
      // Probe failures are tolerated, but still recycle the pool so the
      // next real request lands on fresh sockets.
      void recycleFetchPoolOnFailure('ollama', err);
      const msg = err instanceof Error ? err.message : String(err);
      return { available: false, error: `Cannot reach Ollama at ${baseUrl}: ${msg}` };
    }
  }

  kill(): void {
    for (const ac of this.activeControllers) {
      try { ac.abort(); } catch { /* already aborted */ }
    }
    this.activeControllers.clear();
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
    const abortController = new AbortController();
    this.activeControllers.add(abortController);
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

    // §H4 cross-vendor turn recording — mirrors the OpenRouter agentic port
    // (startTurn → replay-skip → live tool-loop with runTool → endTurn, plus a
    // burned-sentinel on a mid-turn upstream burn). Records every turn so a
    // later resume can reconstruct history; HONORS `replayed` on a same-runId
    // resume so the recorded tool effects re-issue in order (exec never fires)
    // instead of re-running live and tripping a DeterminismViolation. NullTurn-
    // Recorder no-ops without a durable recorder.
    const recorder = config.turnRecorder ?? createNullTurnRecorder({
      runId: config.sessionId,
      stepId: config.stage,
    });
    let activeTurnIdx = -1;
    // false while runOneTurn is streaming → a throw here is a mid-stream burn
    // (record a sentinel). true once it returns → a later throw (endTurn /
    // determinism) must propagate untouched, never get a spurious sentinel.
    let activeTurnComplete = true;

    try {
      for (let iter = 0; iter < maxIter; iter++) {
        // Bound conversation history before each turn. Drops oldest
        // tool_result blocks (least informative — the model already saw
        // them once) keeping the system + user + recent turns intact.
        // If trimming can't bring history below num_ctx, escalate.
        trimHistoryIfNeeded(messages, numCtx, config.model);

        const { turn: turnIdx, replayed } = await recorder.startTurn({
          model: config.model,
          provider: 'ollama',
          system: config.projectPrompt,
          messages: messages.slice(),
          userPrompt: config.userPrompt,
        });
        activeTurnIdx = turnIdx;

        // ── H3 replay-skip ────────────────────────────────────────────
        // This turn's assistant-end is already in the durable log. Skip the
        // upstream call; re-append the EXACT recorded native history (so the
        // next turn's assistant-start hash matches) and re-issue runTool in
        // order so the replay cursor advances (exec never fires — recorded
        // tool_results return verbatim).
        if (replayed) {
          // Burned sentinel: this turn burned mid-stream live. Re-issue its
          // recorded sub-effects (none for ollama — burns happen before any
          // runTool), re-record the sentinel, then re-throw a retryable
          // upstream error so the chain walker re-derives the SAME model→turn
          // mapping it had live, independent of whether the error cleared.
          if (replayed.stopReason === 'burned') {
            for (const m of replayed.historyDelta) messages.push(m as ChatMessage);
            for (const tu of replayed.toolUses) {
              await recorder.runTool(
                turnIdx, tu.name, tu.arguments, tu.idempotencyKey,
                async () => { throw new Error(`replay invariant: exec ran for recorded burned-turn tool ${tu.name}`); },
              );
            }
            await recorder.endTurn(
              turnIdx, replayed.text, 'burned',
              replayed.usage, replayed.provenance, replayed.historyDelta,
            );
            throw new UpstreamError(
              503,
              `ollama replayed burn for "${config.model}" (deterministic chain re-derivation)`,
              { provider: 'ollama', retryable: true },
            );
          }

          aggregatedText += replayed.text;
          totalIn += replayed.usage.inputTokens;
          totalOut += replayed.usage.outputTokens;
          if (replayed.text) emitContent(output, replayed.text);

          if (replayed.toolUses.length === 0 || !config.toolExecutor) {
            stopReason = replayed.stopReason;
            await recorder.endTurn(
              turnIdx, replayed.text, replayed.stopReason,
              replayed.usage, replayed.provenance, replayed.historyDelta,
            );
            break;
          }

          for (const m of replayed.historyDelta) messages.push(m as ChatMessage);
          for (const tu of replayed.toolUses) {
            emitToolUse(output, tu.name, tu.arguments, tu.id);
            const r = await recorder.runTool(
              turnIdx, tu.name, tu.arguments, tu.idempotencyKey,
              async () => { throw new Error(`replay invariant: exec ran for recorded tool ${tu.name}`); },
            );
            const rc = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
            emitToolResult(output, { toolUseId: tu.id, content: rc, isError: !r.ok });
          }
          await recorder.endTurn(
            turnIdx, replayed.text, replayed.stopReason,
            replayed.usage, replayed.provenance, replayed.historyDelta,
          );
          if (abortController.signal.aborted) { stopReason = 'aborted'; break; }
          continue;
        }

        // ── live ──────────────────────────────────────────────────────
        activeTurnComplete = false;
        const turn = await this.runOneTurn(messages, tools, numCtx, config, output, abortController.signal);
        activeTurnComplete = true;
        aggregatedText += turn.text;
        totalIn += turn.inputTokens;
        totalOut += turn.outputTokens;
        totalDurMs += turn.durationMs;

        const usage: TurnTokenUsage = { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens };
        const provenance: Provenance = {
          segments: [{ model: config.model, provider: 'ollama', range: [0, turn.text.length], source: 'live' }],
        };

        if (turn.toolCalls.length === 0 || !config.toolExecutor) {
          stopReason = turn.toolCalls.length === 0 ? 'end_turn' : 'tools_unsupported';
          await recorder.endTurn(turnIdx, turn.text, stopReason, usage, provenance);
          break;
        }

        // Append the assistant's tool-call turn to history so the model
        // sees its own request when we re-prompt with results. Track the
        // exact native messages appended this turn as `historyDelta` so
        // crash-resume re-appends them verbatim (order: assistant, then each
        // tool-result — mirroring the live push order).
        const historyDelta: unknown[] = [];
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: turn.text,
          tool_calls: turn.toolCalls,
        };
        messages.push(assistantMsg);
        historyDelta.push(assistantMsg);

        // Execute every tool call. Sequential — parallel exec via the
        // builtin executor is safe today (each tool is independent),
        // but bash/edit ordering matters when the model chains them,
        // so we serialize.
        for (const toolCall of turn.toolCalls) {
          const callId = randomUUID();
          const args = normalizeArgs(toolCall.function.arguments);
          const call: ToolCall = { id: callId, name: toolCall.function.name, arguments: args };
          emitToolUse(output, call.name, args, callId);

          const idempotencyKey = contentHashFromArgs({ name: call.name, arguments: args });
          const neutralResult: NeutralToolResult = await recorder.runTool(
            turnIdx, call.name, args, idempotencyKey,
            async () => {
              const r = await invokeTool(config.toolExecutor!, call, config.workingDir, abortController.signal);
              return { toolUseId: callId, toolName: call.name, ok: !r.isError, content: r.content };
            },
          );
          const resultContent = typeof neutralResult.content === 'string'
            ? neutralResult.content
            : JSON.stringify(neutralResult.content);
          emitToolResult(output, { toolUseId: callId, content: resultContent, isError: !neutralResult.ok });

          const toolMsg: ChatMessage = {
            role: 'tool',
            content: resultContent,
            tool_call_id: callId,
          };
          messages.push(toolMsg);
          historyDelta.push(toolMsg);
        }

        await recorder.endTurn(turnIdx, turn.text, 'tool_use', usage, provenance, historyDelta);

        if (abortController.signal.aborted) {
          stopReason = 'aborted';
          break;
        }
      }
      if (stopReason === undefined) stopReason = 'iteration_limit';
    } catch (err) {
      // §H3 burn sentinel: a mid-stream upstream burn (runOneTurn threw before
      // returning). Record a `stopReason:'burned'` assistant-end for the
      // active turn so a same-runId resume replays it deterministically
      // (re-throws here) and the chain walker re-derives the identical
      // model→turn mapping. ollama records no tool effects until runOneTurn
      // returns, so the burned turn carries empty historyDelta + toolUses.
      // Only genuine mid-stream burns (NOT aborts, NOT post-turn throws like a
      // DeterminismViolation) get a sentinel.
      if (activeTurnIdx >= 0 && !activeTurnComplete && !abortController.signal.aborted) {
        await recorder.endTurn(
          activeTurnIdx, '', 'burned',
          { inputTokens: 0, outputTokens: 0 }, { segments: [] }, [],
        );
      }
      throw err;
    } finally {
      this.activeControllers.delete(abortController);
    }

    const durationMs = totalDurMs > 0 ? totalDurMs : Date.now() - startMs;

    // Silent-empty defense: agentic loop terminated without final assistant
    // text. Surface as retryable so the dashboard's chain-fallback walks
    // to the next chain entry instead of writing a 0-byte artifact.
    // Mirrors claude-adapter + openrouter-adapter contract.
    //
    // Exclude `iteration_limit` — that's a deliberate caller-side cap, not
    // a model failure. The caller asked us to stop after N iterations and
    // we did exactly that; surfacing it as a retryable upstream error
    // would burn the model on the chain walker for no reason.
    if (!aggregatedText.trim() && stopReason !== 'aborted' && stopReason !== 'iteration_limit') {
      throw new UpstreamError(
        503,
        `ollama model "${config.model}" returned empty final text (stopReason=${stopReason}, outputTokens=${totalOut}, toolCalls=${countToolCalls(messages)})`,
        { provider: 'ollama', retryable: true },
      );
    }

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
    signal: AbortSignal,
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

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
        dispatcher: getFetchPool('ollama'),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      void recycleFetchPoolOnFailure('ollama', err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new UpstreamError(0, `fetch failed: ${msg}`, { provider: 'ollama', retryable: true });
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new UpstreamError(response.status, errBody, { provider: 'ollama' });
    }
    if (!response.body) throw new UpstreamError(0, 'Ollama API returned no response body', { provider: 'ollama' });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    const toolCalls: OllamaToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let durationMs = 0;
    // Buffer text deltas and flush at line breaks (or every ~80 chars)
    // so each activity card holds a readable chunk instead of one
    // word per row.
    let pendingText = '';
    const FLUSH_THRESHOLD = 80;

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
          pendingText += msg.content;
          while (pendingText.includes('\n')) {
            const nl = pendingText.indexOf('\n');
            const lineOut = pendingText.slice(0, nl + 1);
            emitContent(output, lineOut);
            pendingText = pendingText.slice(nl + 1);
          }
          if (pendingText.length >= FLUSH_THRESHOLD) {
            emitContent(output, pendingText);
            pendingText = '';
          }
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
    // Flush trailing content not ending on a newline.
    if (pendingText.length > 0) {
      emitContent(output, pendingText);
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

/**
 * Crude tokens approximation — bytes / 4. Used only to decide when to
 * trim, never as a billing input.
 */
function estimateTokens(messages: ChatMessage[]): number {
  let bytes = 0;
  for (const m of messages) {
    bytes += m.content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        bytes += tc.function.name.length;
        bytes += typeof tc.function.arguments === 'string'
          ? tc.function.arguments.length
          : JSON.stringify(tc.function.arguments).length;
      }
    }
  }
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * Drop the oldest tool-role messages until the history fits below
 * SOFT_TRIM_RATIO × numCtx. Keeps system + user prompts intact (they
 * carry the original task framing) and keeps the most recent turns
 * intact (where the active state of the loop lives). If we can't trim
 * enough — e.g. a single tool_result is bigger than the window —
 * escalate via ContextExhaustedError.
 */
export function trimHistoryIfNeeded(
  messages: ChatMessage[],
  numCtx: number,
  model: string,
): void {
  const cap = Math.floor(numCtx * SOFT_TRIM_RATIO);
  if (estimateTokens(messages) <= cap) return;

  // Walk forward from the start, skipping system/user, drop the FIRST
  // tool message we find. Repeat until under cap or no more droppable
  // tool messages exist.
  while (estimateTokens(messages) > cap) {
    const dropIndex = messages.findIndex((m) => m.role === 'tool');
    if (dropIndex === -1) break;
    messages.splice(dropIndex, 1);
  }

  if (estimateTokens(messages) > numCtx) {
    throw new ContextExhaustedError(model, numCtx, estimateTokens(messages));
  }
}
