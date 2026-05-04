/**
 * Google ADK adapter — agentic, provider-agnostic.
 *
 * Drives `@google/adk` (≥ 1.1.0) end-to-end:
 *   1. Builds an `LlmAgent` with the requested model.
 *   2. Wraps `BuiltinToolExecutor`'s schemas as ADK `FunctionTool`s.
 *   3. Runs the agent through ADK's `Runner` + `InMemorySessionService`.
 *   4. Translates each emitted ADK `Event` into Anvil Stream Format
 *      lines (text → emitContent, FunctionCall → emitToolUse,
 *      FunctionResponse → emitToolResult).
 *
 * Provider routing:
 *   - Model ids prefixed `adk:` (e.g. `adk:claude-sonnet-4-6`,
 *     `adk:gemini-2.5-flash`) route to this adapter via the
 *     `default-adapter-factory` resolver. Claude models go through the
 *     custom `AnthropicLlm` (registered idempotently here); Gemini
 *     models flow through ADK's built-in `Gemini` Llm.
 *   - The prefix is stripped before being handed to ADK's
 *     `LLMRegistry`, which matches against the model id directly
 *     (e.g. `^claude-/`).
 *
 * Capabilities are `tier: 'agentic'` because the Runner drives a real
 * tool loop. Per-call `AbortController` + buffered emitContent match
 * the patterns in `OllamaAdapter` / `OpenRouterAdapter` so concurrent
 * spawns (per-repo backend + frontend) don't trample each other.
 *
 * Auth: `ANTHROPIC_API_KEY` for Claude models, `GOOGLE_API_KEY` /
 * `GEMINI_API_KEY` for Gemini.
 */

import { randomUUID } from 'node:crypto';

import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
  ToolExecutorLike,
} from './types.js';
import {
  emitContent as emitContentRaw,
  emitResult,
  emitToolResult,
  emitToolUse,
} from './stream-format.js';
import { registerAnthropicLlm } from './adk-anthropic-llm.js';
import { UpstreamError, bodyLooksRetryable } from './upstream-error.js';

const PREFIX = 'adk:';

/**
 * Defuse ADK's prompt template engine for source code we inject.
 *
 * ADK (`@google/adk`'s `instructions.js`) scans the prompt with
 * `/\{+[^{}]*\}+/g`, strips ALL leading `{` and trailing `}`, trims,
 * then if the residue matches `^[a-zA-Z_][a-zA-Z0-9_]*$` (a valid
 * identifier) it tries to resolve it against the session state — and
 * throws `Context variable not found: \`<name>\`` if it isn't there.
 *
 * Doubling braces does NOT help — `{{modalOpen}}` → strip `{+` / `}+`
 * → `modalOpen` → still throws. Anvil doesn't use ADK's templating;
 * we substitute our own `{{...}}` in `prompt-builders.ts:injectTemplateVars`
 * before this call. By the time content lands here, every remaining
 * `{name}` comes from KB-injected source code (TypeScript template
 * literals, JSX expressions, Go struct literals).
 *
 * Insert a zero-width space (U+200B) right after every `{`. ADK still
 * matches the regex but the resulting key starts with ZWSP, which
 * fails the identifier check, so ADK returns `match[0]` unchanged
 * instead of looking up state. ZWSP is invisible to the model — the
 * source code reads identically.
 *
 * Provider-local: only ADK has this templating layer. Other adapters
 * receive the raw prompt unchanged.
 */
function escapeAdkBraces(text: string): string {
  return text.replace(/\{/g, '{\u200B');
}

const ADK_PRICING: Record<string, [number, number]> = {
  // Claude (Anthropic API)
  'claude-haiku-4-5':  [1.0, 5.0],
  'claude-sonnet-4-6': [3.0, 15.0],
  'claude-sonnet-4-7': [3.0, 15.0],
  'claude-opus-4-7':   [15.0, 75.0],
  // Gemini
  'gemini-2.5-flash':  [0.075, 0.30],
  'gemini-2.5-pro':    [1.25, 5.00],
};

export class AdkAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'adk';
  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: false,
    cache: 'explicit',
    cacheTtlSeconds: 300,
    structuredOutput: 'tool-shim',
    maxOutputTokens: true,
  };

  private readonly abortControllers = new Set<AbortController>();

  supportsModel(modelId: string): boolean {
    return modelId.startsWith(PREFIX);
  }

  getModelPricing(modelId: string): [number, number] | null {
    const stripped = modelId.startsWith(PREFIX) ? modelId.slice(PREFIX.length) : modelId;
    return ADK_PRICING[stripped] ?? null;
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const adk = await loadAdk();
      const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
      const hasGemini = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY);
      if (!hasAnthropic && !hasGemini) {
        return {
          available: false,
          error: 'Set ANTHROPIC_API_KEY (for adk:claude-*) or GOOGLE_API_KEY / GEMINI_API_KEY (for adk:gemini-*).',
        };
      }
      // Touch the registry so we can confirm the package's surface is wired.
      // Throws cleanly if the install is broken.
      void adk.LLMRegistry;
      return { available: true, version: '@google/adk' };
    } catch (err) {
      return {
        available: false,
        error: `@google/adk is not installed or failed to load: ${(err as Error).message}`,
      };
    }
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const startedAt = Date.now();
    const upstreamModel = config.model.startsWith(PREFIX) ? config.model.slice(PREFIX.length) : config.model;

    const adk = await loadAdk();

    // Register Anthropic Llm exactly once per process — idempotent.
    registerAnthropicLlm();

    // Bridge `GOOGLE_API_KEY` → `GEMINI_API_KEY` for users who set the
    // generic Google key. ADK's Gemini class only reads
    // `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY`. Don't overwrite if
    // already set.
    if (
      upstreamModel.startsWith('gemini-') &&
      !process.env.GEMINI_API_KEY &&
      !process.env.GOOGLE_GENAI_API_KEY &&
      process.env.GOOGLE_API_KEY
    ) {
      process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
    }

    // Per-call AbortController so concurrent spawns can't trample each other.
    const ac = new AbortController();
    this.abortControllers.add(ac);

    const buffered = makeBufferedEmitter(output);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let toolCallCount = 0;
    let stopReason = 'end_turn';
    let finalText = '';

    try {
      const tools = buildAdkTools(adk, config.toolExecutor, {
        workingDir: config.workingDir,
        abortSignal: ac.signal,
      });

      const agent = new adk.LlmAgent({
        name: 'anvil_adk_agent',
        description: `Anvil agent (${config.persona ?? 'engineer'} stage=${config.stage ?? 'unknown'})`,
        model: upstreamModel,
        // ADK's prompt template engine treats `{varname}` as a context
        // variable lookup and 500s on unresolved vars. Real source code
        // injected via the KB / file reads naturally contains `{...}`
        // (TypeScript template literals like `${adoptionId}`, JSON object
        // literals, JSX expressions). We don't use ADK's templating —
        // our own `injectTemplateVars` already substitutes `{{...}}`
        // before this call. So escape every brace by doubling it; ADK
        // unescapes `{{` → `{` and `}}` → `}` when rendering. Provider-
        // local because no other adapter parses braces this way.
        instruction: escapeAdkBraces(config.projectPrompt ?? ''),
        tools,
      });

      const sessionService = new adk.InMemorySessionService();
      const runner = new adk.Runner({
        appName: 'anvil',
        agent,
        sessionService,
      });

      const userId = config.sessionId ?? `anvil-${randomUUID()}`;
      const events = runner.runEphemeral({
        userId,
        newMessage: { role: 'user', parts: [{ text: escapeAdkBraces(config.userPrompt) }] },
      });

      // Wrap the iteration so plain Errors thrown by the underlying
      // LLM (ADK's stock Gemini class throws plain Error on 429 /
      // quota; our AnthropicLlm already throws UpstreamError directly)
      // can be classified for the dashboard's chain-fallback duck-type
      // check after the loop exits.
      let iterError: unknown = null;
      const wrapped = wrapIteratorErrors(events, (e) => { iterError = e; });
      for await (const evt of wrapped) {
        if (ac.signal.aborted) break;

        const usage = evt.usageMetadata;
        if (usage) {
          totalInputTokens += usage.promptTokenCount ?? 0;
          totalOutputTokens += usage.candidatesTokenCount ?? 0;
          if (typeof usage.cachedContentTokenCount === 'number') {
            cacheReadTokens += usage.cachedContentTokenCount;
          }
        }
        if (evt.finishReason) stopReason = String(evt.finishReason).toLowerCase();

        // Translate parts → Anvil Stream Format. ADK fires content,
        // function_call, and function_response in separate events so
        // the partitioning is easy.
        const parts = evt.content?.parts ?? [];
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            buffered.push(part.text);
            // Track for the final result line — last text wins as the
            // canonical "answer".
            finalText = part.text;
          } else if (part.functionCall) {
            buffered.flush();
            const id = part.functionCall.id ?? randomUUID();
            emitToolUse(
              output,
              part.functionCall.name ?? '',
              (part.functionCall.args ?? {}) as Record<string, unknown>,
              id,
            );
            toolCallCount += 1;
          } else if (part.functionResponse) {
            buffered.flush();
            const resp = part.functionResponse.response ?? {};
            emitToolResult(output, {
              toolUseId: part.functionResponse.id ?? '',
              content: typeof resp === 'string' ? resp : JSON.stringify(resp),
              isError: typeof resp === 'object' && resp != null && 'error' in (resp as Record<string, unknown>),
            });
          }
        }

        if (evt.errorMessage) {
          // Classify the in-band error so the dashboard's chain-fallback
          // can hop to another provider when an LLM hits quota/rate
          // limit but ADK chose to surface it via `errorMessage`
          // instead of throwing.
          const retryable = bodyLooksRetryable(evt.errorMessage);
          throw new UpstreamError(retryable ? 503 : 500, evt.errorMessage, {
            provider: upstreamModel.startsWith('claude-') ? 'anthropic' : 'gemini',
            retryable,
          });
        }
      }

      // Surface any error the AsyncGenerator threw mid-stream. If the
      // underlying LLM was our AnthropicLlm, it's already an UpstreamError
      // (with `retryable` set correctly). For ADK's stock Gemini path
      // we get a plain Error — classify by message body so we don't
      // lose chain-fallback on 429/quota.
      if (iterError) {
        if (iterError instanceof UpstreamError) throw iterError;
        const e = iterError as Error;
        const msg = e?.message ?? String(iterError);
        const retryable = bodyLooksRetryable(msg);
        throw new UpstreamError(retryable ? 429 : 500, msg, {
          provider: upstreamModel.startsWith('claude-') ? 'anthropic' : 'gemini',
          retryable,
        });
      }

      buffered.flush();

      const pricing = this.getModelPricing(config.model);
      const costUsd = pricing
        ? (totalInputTokens * pricing[0] + totalOutputTokens * pricing[1]) / 1_000_000
        : 0;

      emitResult(output, {
        text: finalText,
        costUsd,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        durationMs: Date.now() - startedAt,
        sessionId: userId,
        cacheReadTokens,
        cacheWriteTokens,
      });

      return {
        output: finalText,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd,
        durationMs: Date.now() - startedAt,
        sessionId: userId,
        provider: this.provider,
        model: config.model,
        cacheReadTokens,
        cacheWriteTokens,
        toolCallCount,
        stopReason,
      };
    } finally {
      this.abortControllers.delete(ac);
    }
  }

  kill(): void {
    for (const ac of this.abortControllers) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    this.abortControllers.clear();
  }
}

// ───────────────────────────────────────────────────────────────────────
// AsyncGenerator error capture
// ───────────────────────────────────────────────────────────────────────

/**
 * Iterates an async iterable and captures any thrown error in `onError`
 * instead of re-throwing it through the loop. The wrapped generator
 * stops yielding on the first throw; the caller checks `iterError`
 * after the for-await exits and re-throws (with classification) so
 * the dashboard's chain-fallback duck-type check sees an UpstreamError.
 */
async function* wrapIteratorErrors<T>(
  src: AsyncIterable<T>,
  onError: (e: unknown) => void,
): AsyncGenerator<T, void, undefined> {
  try {
    for await (const v of src) yield v;
  } catch (e) {
    onError(e);
  }
}

// ───────────────────────────────────────────────────────────────────────
// ADK module loader (dynamic so the agent-core build doesn't hard-require
// the 580-package ADK install for users who don't use this adapter).
// ───────────────────────────────────────────────────────────────────────

interface AdkExports {
  LlmAgent: typeof import('@google/adk').LlmAgent;
  Runner: typeof import('@google/adk').Runner;
  InMemorySessionService: typeof import('@google/adk').InMemorySessionService;
  FunctionTool: typeof import('@google/adk').FunctionTool;
  LLMRegistry: typeof import('@google/adk').LLMRegistry;
  BaseTool: typeof import('@google/adk').BaseTool;
}

let cachedAdk: AdkExports | null = null;

async function loadAdk(): Promise<AdkExports> {
  if (cachedAdk) return cachedAdk;
  // Variable-form import so a TS environment without the package can
  // still type-check this file (the static `import type` above is
  // erased; this dynamic import resolves at runtime).
  const pkg = '@google/adk';
  const mod = (await import(pkg)) as AdkExports;
  // Silence ADK's default INFO-level logger — it dumps every Runner
  // event (including the full request prompt) to stderr, which floods
  // the dashboard's terminal once ADK is in the chain. Drop to ERROR
  // so genuine failures still surface. Set `ANVIL_ADK_LOG=info|debug`
  // to opt back in when debugging the adapter itself.
  try {
    const m = mod as unknown as {
      setLogLevel?: (n: number) => void;
      LogLevel?: { DEBUG?: number; INFO?: number; WARN?: number; ERROR?: number };
    };
    const wantedRaw = (process.env.ANVIL_ADK_LOG ?? 'error').toLowerCase();
    const wanted = wantedRaw === 'debug' ? m.LogLevel?.DEBUG
      : wantedRaw === 'info' ? m.LogLevel?.INFO
      : wantedRaw === 'warn' ? m.LogLevel?.WARN
      : m.LogLevel?.ERROR;
    if (typeof wanted === 'number' && typeof m.setLogLevel === 'function') {
      m.setLogLevel(wanted);
    }
  } catch { /* non-fatal — just keeps ADK noisy */ }
  cachedAdk = mod;
  return mod;
}

// ───────────────────────────────────────────────────────────────────────
// Tool translation: BuiltinToolExecutor schemas → ADK FunctionTool[]
// ───────────────────────────────────────────────────────────────────────

function buildAdkTools(
  adk: AdkExports,
  executor: ToolExecutorLike | undefined,
  ctx: { workingDir: string; abortSignal: AbortSignal },
): InstanceType<typeof adk.FunctionTool>[] {
  if (!executor) return [];
  const out: InstanceType<typeof adk.FunctionTool>[] = [];
  for (const schema of executor.listSchemas()) {
    out.push(new adk.FunctionTool({
      name: schema.name,
      description: schema.description,
      // ADK's FunctionTool accepts a JSON Schema in `parameters`; ADK
      // forwards it as `parametersJsonSchema` to the underlying LLM
      // (so AnthropicLlm picks it up via collectTools).
      parameters: schema.inputSchema as never,
      execute: async (input: unknown) => {
        const args = (input ?? {}) as Record<string, unknown>;
        const result = await executor.execute(
          { id: randomUUID(), name: schema.name, arguments: args },
          { workingDir: ctx.workingDir, abortSignal: ctx.abortSignal },
        );
        // Anthropic's FunctionResponse expects a JSON-serializable
        // object. We package error / output uniformly so AnthropicLlm
        // can detect failures via the `error` key.
        if (result.isError) {
          return { error: result.content };
        }
        return { output: result.content };
      },
    }));
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Buffered emitContent — flush on '\n' OR ~80 chars so the dashboard
// activity log reads as prose, not vertical tokens. Same convention as
// OpenRouter / Ollama adapters.
// ───────────────────────────────────────────────────────────────────────

function makeBufferedEmitter(output: NodeJS.WritableStream): { push(s: string): void; flush(): void } {
  let buf = '';
  const FLUSH_AT = 80;
  function flushNow(): void {
    if (buf.length === 0) return;
    emitContentRaw(output, buf);
    buf = '';
  }
  return {
    push(s: string): void {
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl + 1);
        emitContentRaw(output, line);
        buf = buf.slice(nl + 1);
      }
      if (buf.length >= FLUSH_AT) flushNow();
    },
    flush: flushNow,
  };
}
