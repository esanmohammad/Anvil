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
import { TurnRecorder, createNullTurnRecorder } from './turn-recorder/index.js';
import type { NeutralToolResult, Provenance, TurnTokenUsage } from './turn-recorder/types.js';
import { contentHashFromArgs } from './turn-recorder/hash.js';
import { materializePrefill, materializePriorTurns } from './prefill/translate.js';
import { stripForTarget } from './prefill/strip.js';

const DEFAULT_MAX_ITERATIONS = 32;

/**
 * Re-export the shared `UpstreamError` so existing imports
 * (`import { UpstreamError } from '@esankhan3/anvil-agent-core/openrouter-adapter'`)
 * keep working. The class itself lives in `upstream-error.ts` and is
 * shared by every adapter that talks to a remote provider.
 */
export { UpstreamError } from './upstream-error.js';
import { UpstreamError as _UpstreamError } from './upstream-error.js';
import {
  getFetchPool,
  recycleFetchPoolOnFailure,
  type ProviderId,
} from './fetch-pool.js';

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

/**
 * Live, mutable working state for one streamed turn. `consumeSSE` writes
 * into this as deltas arrive, so the `run()` catch block can read the
 * partial assistant text + in-flight tool_calls when the stream dies
 * mid-output (v2 ADR §2.1.1 / §2.5 partial flush). Without surfacing
 * this, the streamed text lived in a `consumeSSE` local that vanished
 * on throw and `flushPartial` would persist an empty string.
 */
interface TurnAccumulator {
  text: string;
  toolCalls: Map<number, AccumulatedToolCall>;
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
    // §Tier 2 stateful resume: re-present COMPLETED prior turns BEFORE this
    // phase's user message so a non-claude session keeps full conversation
    // context across start→sendInput. materializePriorTurns emits clean
    // target-format messages (no vendor keys), so no stripForTarget is
    // needed. Empty/undefined → byte-identical to the single-turn path.
    if (config.priorMessages?.length) {
      messages.push(...(materializePriorTurns(config.priorMessages, this.provider) as ChatMessage[]));
    }
    messages.push({ role: 'user', content: config.userPrompt });

    // Prefill continuation (v2 ADR §2.3): a prior chain entry burned
    // mid-stream. Re-present its completed tool calls + partial
    // assistant text in this provider's wire shape so this model
    // continues from the exact character instead of regenerating. The
    // recorded tool results are replayed (not re-executed) — their
    // side effects already happened on the burned model. Strip applies
    // any cross-vendor field removal; materialize emits OpenAI-compat
    // shape (this adapter family).
    if (config.prefill) {
      const materialized = materializePrefill(config.prefill, this.provider) as ChatMessage[];
      const safe = stripForTarget(materialized, {
        sourceProvider: config.prefill.sourceProvider,
        targetProvider: this.provider,
      }) as ChatMessage[];
      messages.push(...safe);
    }

    const tools = config.toolExecutor ? mapSchemasToOpenAI(config.toolExecutor.listSchemas()) : undefined;
    const maxIter = config.maxToolIterations ?? DEFAULT_MAX_ITERATIONS;

    // Turn-level durable recorder (v2 ADR §2.5). Defaults to a no-op
    // recorder when the caller hasn't injected a real one — structural
    // calls happen either way, persistence is gated on whether a real
    // EffectRuntime + partial sink were threaded through the bridge.
    // This is NOT a feature flag: it's the bridge between un-ported and
    // ported call sites during the H1→H4 cutover. Once the pipeline
    // injects a real recorder everywhere, this fallback drops out.
    const recorder = config.turnRecorder ?? createNullTurnRecorder({
      runId: config.sessionId,
      stepId: config.stage,
    });

    let aggregatedText = '';
    let totalIn = 0;
    let totalOut = 0;
    let totalCachedReadTokens = 0;
    let totalReasoningTokens = 0;
    let openRouterCost = 0;
    let stopReason: string | undefined;
    let providerFinishReason: string | undefined;
    // Track the current turn for catch-block flushPartial. -1 means
    // we never opened a turn (catch fired before startTurn). `activeAcc`
    // is the live accumulator runOneTurn writes into, so the catch reads
    // whatever streamed before a mid-turn throw. `activeTurnSseComplete`
    // flips true the instant runOneTurn returns (the SSE finished); the
    // catch flushes a partial ONLY when this is false — i.e. the stream
    // itself was interrupted, NOT when a post-stream step (endTurn, tool
    // dispatch, an effect-runtime determinism error) throws after the
    // turn's text was already fully received. Without this guard the
    // catch would persist a "partial" carrying the COMPLETE turn text
    // and mislabel its reason (review finding: spurious partial flush).
    let activeTurnIdx = -1;
    let activeAcc: TurnAccumulator | null = null;
    let activeTurnSseComplete = false;
    // §H3 burn sentinel: the provider-native messages appended SO FAR in the
    // active turn (assistant msg + tool-result msgs). On a mid-stream burn the
    // catch records these into a `stopReason:'burned'` assistant-end so replay
    // re-appends them verbatim before re-burning. Reset at each live turn; []
    // for the common case (runOneTurn burns before any message is appended).
    let activeHistoryDelta: unknown[] = [];

    try {
      for (let iter = 0; iter < maxIter; iter++) {
        // The prefill (§2.3) is consumed on the FIRST turn only — it's the
        // continuation handed by the chain walker after a burn. Turns 1+
        // of this same adapter run are fresh, un-prefilled generations.
        const turnPrefill = iter === 0 ? config.prefill : undefined;

        const { turn: turnIdx, replayed } = await recorder.startTurn({
          model: config.model,
          provider: this.provider,
          system: config.projectPrompt,
          messages: messages.slice(),
          prefill: turnPrefill,
          // §Tier 2: record this phase's user prompt so a stateful resume can
          // reconstruct prior turns WITH their prompts. Every turn of one
          // run() carries the same prompt; reconstruction de-dupes per phase.
          userPrompt: config.userPrompt,
        });
        activeTurnIdx = turnIdx;

        // ── H3 replay-skip ────────────────────────────────────────────
        // This turn's `assistant-end` is already in the durable log (a
        // prior process ran it). Skip the upstream call entirely; re-append
        // the EXACT recorded native history so the next turn's
        // assistant-start hash matches, and re-issue runTool/endTurn in
        // order so the replay cursor advances over the recorded sub-effects
        // (exec never fires — recorded tool_results are returned verbatim).
        if (replayed) {
          activeTurnSseComplete = true; // no live SSE happened this turn

          // §H3 burned-turn replay: this turn burned mid-stream live (its
          // assistant-end is a `stopReason:'burned'` sentinel). Re-issue its
          // recorded tool sub-effects in order (advancing the replay cursor;
          // exec NEVER fires — recorded results are returned verbatim),
          // re-record the sentinel end, then re-throw a retryable upstream
          // error so the chain walker burns this model and continues to the
          // next exactly as it did live. This keeps the model→turn mapping
          // deterministic regardless of whether the transient error cleared.
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
            throw new _UpstreamError(
              503,
              `${this.provider} replayed burn for "${config.model}" (deterministic chain re-derivation)`,
              { provider: this.provider, retryable: true },
            );
          }

          aggregatedText += replayed.text;
          totalIn += replayed.usage.inputTokens;
          totalOut += replayed.usage.outputTokens;
          totalCachedReadTokens += replayed.usage.cacheReadTokens ?? 0;
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

        activeTurnSseComplete = false;
        activeHistoryDelta = [];
        const acc: TurnAccumulator = { text: '', toolCalls: new Map() };
        activeAcc = acc;

        const turn = await this.runOneTurn(apiKey, messages, tools, config, output, abortController.signal, acc);
        // SSE finished cleanly for this turn — any throw past this point
        // (endTurn, tool dispatch, effect determinism) is NOT a mid-stream
        // burn, so the catch must not flush a spurious partial.
        activeTurnSseComplete = true;
        aggregatedText += turn.text;
        totalIn += turn.inputTokens;
        totalOut += turn.outputTokens;
        totalCachedReadTokens += turn.cachedReadTokens;
        totalReasoningTokens += turn.reasoningTokens;
        openRouterCost += turn.cost;
        if (turn.finishReason) providerFinishReason = turn.finishReason;

        // §2.6 prefill cost: when this turn re-injected a prior model's
        // text, carve out those tokens so the cost rollup can bill them to
        // a separate reinjection bucket (sourceTokens is the durable count
        // model A reported). §2.7 provenance: two segments when prefilled.
        const usage: TurnTokenUsage = {
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cachedReadTokens,
          ...(turnPrefill ? { prefilledInputTokens: turnPrefill.sourceTokens } : {}),
        };
        const provenance = buildProvenance(config.model, this.provider, turn.text, turnPrefill);

        if (turn.toolCalls.length === 0 || !config.toolExecutor) {
          stopReason = turn.toolCalls.length === 0 ? 'end_turn' : 'tools_unsupported';
          await recorder.endTurn(turnIdx, turn.text, stopReason, usage, provenance);
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
        // §H3 historyDelta: capture the EXACT native messages appended this
        // turn so crash-resume re-appends them verbatim (recorded in
        // assistant-end). Order matters — assistant message first, then
        // each tool-result message — and must mirror the live push order.
        const historyDelta: unknown[] = activeHistoryDelta;
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: turn.text || null,
          ...(this.stripReasoningEcho()
            ? {}
            : turn.reasoningDetails.length > 0
              ? { reasoning_details: turn.reasoningDetails }
              : (turn.reasoning ? { reasoning: turn.reasoning } : {})),
          tool_calls: turn.toolCalls,
        };
        messages.push(assistantMsg);
        historyDelta.push(assistantMsg);

        for (const tc of turn.toolCalls) {
          const args = parseArgs(tc.function.arguments);
          const call: ToolCall = { id: tc.id, name: tc.function.name, arguments: args };
          emitToolUse(output, call.name, args, tc.id);

          const idempotencyKey = contentHashFromArgs({ name: call.name, arguments: args });
          const neutralResult: NeutralToolResult = await recorder.runTool(
            turnIdx,
            call.name,
            args,
            idempotencyKey,
            async () => {
              const r = await invokeTool(config.toolExecutor!, call, config.workingDir, abortController.signal);
              return {
                toolUseId: tc.id,
                toolName: call.name,
                ok: !r.isError,
                content: r.content,
              };
            },
          );

          const resultContent = typeof neutralResult.content === 'string'
            ? neutralResult.content
            : JSON.stringify(neutralResult.content);
          emitToolResult(output, { toolUseId: tc.id, content: resultContent, isError: !neutralResult.ok });

          const toolMsg: ChatMessage = {
            role: 'tool',
            content: resultContent,
            tool_call_id: tc.id,
          };
          messages.push(toolMsg);
          historyDelta.push(toolMsg);
        }

        await recorder.endTurn(
          turnIdx,
          turn.text,
          turn.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
          usage,
          provenance,
          historyDelta,
        );

        if (abortController.signal.aborted) {
          stopReason = 'aborted';
          break;
        }
      }
      if (stopReason === undefined) stopReason = 'iteration_limit';
    } catch (err) {
      // Best-effort partial flush: capture whatever the current turn
      // managed to stream before the throw. NullTurnRecorder no-ops
      // this; real recorders durably persist it for the chain walker
      // to read. We swallow no errors — the upstream throw proceeds
      // after the (synchronous) flushPartial returns.
      //
      // §2.1.1 truncation rule: only count tool_use blocks whose
      // streamed `arguments` parse as clean JSON. A tool call cut off
      // mid-args (unparseable) is NOT counted and NOT replayed — model
      // B re-decides whether to call it. `text` is whatever streamed.
      if (activeTurnIdx >= 0 && activeAcc && !activeTurnSseComplete) {
        // Only a genuine mid-stream interruption gets a partial. By the
        // time we flush, any non-abort failure is an upstream/network
        // interruption (a socket drop surfaces as a bare TypeError from
        // consumeSSE's reader, NOT an UpstreamError — so the old
        // `err.name === 'UpstreamError'` check mislabeled those as
        // 'timeout'). Collapse to abort-vs-upstream.
        const reason: 'abort' | 'upstream' = abortController.signal.aborted ? 'abort' : 'upstream';
        recorder.flushPartial(
          activeTurnIdx,
          activeAcc.text,
          countParsedToolUses(activeAcc.toolCalls),
          reason,
        );
        // §H3 burn sentinel: record a `stopReason:'burned'` assistant-end for
        // the interrupted turn so crash-resume replays it deterministically.
        // On replay startTurn sees this end → the replay-skip branch re-issues
        // the recorded tool sub-effects (advancing the cursor), re-appends
        // historyDelta, then re-throws so chain-fallback re-derives the SAME
        // model→turn mapping it had live — independent of whether the
        // transient upstream error has since cleared. Without it a recovered
        // model would complete the turn live (writing a NEW assistant-end) and
        // collide with the recorded continuation turn → DeterminismViolation.
        // Only genuine upstream burns get a sentinel; an abort (cancellation)
        // must stay resumable as a fresh turn. usage:{} so the per-model cost
        // rollup prices the burn via the partial (output estimate), not twice.
        if (reason === 'upstream') {
          await recorder.endTurn(
            activeTurnIdx,
            activeAcc.text,
            'burned',
            { inputTokens: 0, outputTokens: 0 },
            { segments: [] },
            activeHistoryDelta,
          );
        }
      }
      throw err;
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
    /** Live working state — written as deltas stream so a mid-stream
     *  throw still leaves the partial text/tool_calls readable by the
     *  caller's catch block. */
    acc: TurnAccumulator,
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

    const poolId = this.provider as ProviderId;
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
        // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
        dispatcher: getFetchPool(poolId),
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
      // Fire-and-forget pool recycle — heals zombie sockets for the next
      // chain entry. We still throw so the walker advances.
      void recycleFetchPoolOnFailure(poolId, err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new _UpstreamError(0, `fetch failed: ${msg}`, { provider: this.provider, retryable: true });
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new _UpstreamError(response.status, errBody, { provider: this.provider });
    }
    if (!response.body) throw new _UpstreamError(0, `${this.provider} returned no response body`, { provider: this.provider });

    return this.consumeSSE(response, output, signal, acc);
  }

  /**
   * Drain the SSE stream. Reassembles `tool_calls` from streamed deltas
   * (OpenAI sends arguments as multiple chunks indexed by tool-call
   * `index`). Emits text deltas to the output stream as they arrive.
   */
  private async consumeSSE(
    response: Response,
    output: NodeJS.WritableStream,
    signal: AbortSignal,
    acc: TurnAccumulator,
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
    let reasoning = '';
    const reasoningDetails: ReasoningDetail[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedReadTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    let finishReason: string | undefined;
    // Text + tool_calls live on the shared accumulator (not locals) so a
    // mid-stream throw leaves them readable by run()'s catch (§2.1 / §2.5).
    const toolCallsByIndex = acc.toolCalls;

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
        // Abort latch (§2.1.2): once the per-call signal has aborted,
        // drop every remaining delta. A pull-reader normally rejects on
        // abort, but a final frame can still be buffered in `lines` from
        // the last successful read() — this guarantees post-abort deltas
        // never mutate the accumulator (which would corrupt the partial
        // we're about to flush).
        if (signal.aborted) break;

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
          acc.text += delta.content;
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
      text: acc.text,
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

/**
 * §2.1.1 mid-`tool_use` truncation rule. Counts only the streamed
 * tool_calls whose `arguments` parse as clean, complete JSON AND that
 * carry a non-empty name. A tool call cut off mid-args (e.g. the stream
 * died at `{"path": "src/fo`) is unparseable and excluded — it must NOT
 * be replayed against partial JSON; the next model re-decides. Empty
 * `arguments` is treated as the valid empty-object call `{}`.
 */
function countParsedToolUses(toolCalls: Map<number, AccumulatedToolCall>): number {
  let n = 0;
  for (const tc of toolCalls.values()) {
    if (!tc.function.name) continue;
    const raw = tc.function.arguments;
    if (raw === '' ) { n += 1; continue; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') n += 1;
    } catch {
      // unparseable / truncated args — drop per §2.1.1
    }
  }
  return n;
}

/**
 * §2.7 provenance. Without a prefill: one `live` segment covering the
 * model's full output. WITH a prefill (a chain-fallback resume): two
 * segments over the LOGICAL combined text — `[0, prefill.len)` attributed
 * to the source model as `prefill`, `[prefill.len, prefill.len+live.len)`
 * attributed to the live model. Ranges are CHARACTER offsets, contiguous
 * and non-overlapping (replay reads them back verbatim). An empty live
 * continuation yields a zero-width live segment, which is valid.
 */
function buildProvenance(
  model: string,
  provider: ProviderName,
  liveText: string,
  prefill?: { text: string; sourceProvider: ProviderName; sourceModel?: string },
): Provenance {
  if (prefill && prefill.text.length > 0) {
    const cut = prefill.text.length;
    return {
      segments: [
        { model: prefill.sourceModel ?? 'unknown', provider: prefill.sourceProvider, range: [0, cut], source: 'prefill' },
        { model, provider, range: [cut, cut + liveText.length], source: 'live' },
      ],
    };
  }
  return {
    segments: [{ model, provider, range: [0, liveText.length], source: 'live' }],
  };
}
