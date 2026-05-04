/**
 * Anthropic-backed `BaseLlm` for Google ADK (`@google/adk` ≥ 1.1.0).
 *
 * ADK's TypeScript SDK ships only Gemini / Apigee adapters out of the
 * box; Python/Java ADK have native multi-provider support. This file
 * plugs Anthropic into ADK's `LLMRegistry` so
 *   `new LlmAgent({ model: 'claude-sonnet-4-6', ... })`
 * works inside an ADK `Runner`.
 *
 * Translation map (ADK / @google/genai shape  ↔  Anthropic Messages API):
 *
 *   Content[] (role='user'|'model')          ↔  messages[] (role='user'|'assistant')
 *   Part.text                                ↔  text content block
 *   Part.functionCall {id,name,args}         ↔  tool_use {id,name,input}
 *   Part.functionResponse {id,name,response} ↔  tool_result {tool_use_id,content}
 *   FunctionDeclaration                       ↔  tools[].input_schema
 *
 * Streaming uses Anthropic's SSE event format (`message_start` →
 * `content_block_start/_delta/_stop` → `message_delta` → `message_stop`).
 * We yield one `LlmResponse` per turn-completed assistant message —
 * ADK's `Runner` then dispatches any tool_use parts to the registered
 * `FunctionTool` instances and re-invokes us with the function
 * responses appended.
 *
 * Registration is idempotent — `registerAnthropicLlm()` no-ops on
 * subsequent calls. Call it once before constructing an `LlmAgent`
 * with a `claude-*` model id.
 */

import { randomUUID } from 'node:crypto';
import { BaseLlm, LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse, BaseLlmConnection } from '@google/adk';
import type { Content, Part, FunctionDeclaration } from '@google/genai';
import { UpstreamError } from './upstream-error.js';

// ───────────────────────────────────────────────────────────────────────
// Anthropic wire-format types (subset we use)
// ───────────────────────────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: AnthropicUsage;
}

// ───────────────────────────────────────────────────────────────────────
// AnthropicLlm
// ───────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicLlm extends BaseLlm {
  /**
   * Patterns that route to this Llm via `LLMRegistry.resolve(model)`.
   * Matches `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`,
   * `claude-3-5-haiku-latest`, etc. Does NOT match OpenRouter slugs
   * (`anthropic/claude-...`) — those go through `OpenRouterAdapter`.
   *
   * Typed as the (mutable) array shape ADK's `LLMRegistry.register`
   * expects — the registry uses `Array<string | RegExp>` for its key,
   * so a `ReadonlyArray` here is rejected at the static side.
   *
   * NOTE: ADK's registry wraps each pattern with `^...$` at resolve
   * time. Our regex MUST cover the full id (no `^` anchor of our own,
   * and a trailing `.*` so the wrapped regex stays well-formed). The
   * source pattern is `claude-` followed by `.*`.
   */
  static override readonly supportedModels: Array<string | RegExp> = [/claude-.*/];

  constructor(params: { model: string }) {
    super(params);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set; cannot reach Anthropic via ADK.',
      );
    }

    const system = extractSystemInstruction(llmRequest);
    const messages = convertContentsToAnthropic(llmRequest.contents);
    const tools = collectTools(llmRequest);

    const body: AnthropicMessagesRequest = {
      model: this.model,
      max_tokens: clampInt(llmRequest.config?.maxOutputTokens, DEFAULT_MAX_TOKENS, 1, 64_000),
      messages,
      stream: stream ?? false,
    };
    if (system) body.system = system;
    if (tools.length > 0) body.tools = tools;
    if (llmRequest.config?.temperature != null) body.temperature = llmRequest.config.temperature;
    if (llmRequest.config?.topP != null) body.top_p = llmRequest.config.topP;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new UpstreamError(response.status, errBody || '(empty body)', { provider: 'anthropic' });
    }

    if (body.stream && response.body) {
      yield* parseAnthropicSseToLlmResponse(response.body);
    } else {
      const json = (await response.json()) as AnthropicMessageResponse;
      yield convertAnthropicMessageToLlmResponse(json);
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'AnthropicLlm does not support live (bidi) connections. Use generateContentAsync.',
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// Idempotent registration
// ───────────────────────────────────────────────────────────────────────

let registered = false;

/**
 * Register `AnthropicLlm` with ADK's `LLMRegistry`. Safe to call
 * multiple times — only the first call registers.
 */
export function registerAnthropicLlm(): void {
  if (registered) return;
  LLMRegistry.register(AnthropicLlm);
  registered = true;
}

// ───────────────────────────────────────────────────────────────────────
// Translation: ADK Content[] → Anthropic messages[]
// ───────────────────────────────────────────────────────────────────────

function extractSystemInstruction(req: LlmRequest): string {
  const sys = req.config?.systemInstruction;
  if (!sys) return '';
  if (typeof sys === 'string') return sys;
  if (typeof sys === 'object' && 'parts' in sys && Array.isArray((sys as Content).parts)) {
    return ((sys as Content).parts ?? []).map(p => p.text ?? '').join('');
  }
  return '';
}

function convertContentsToAnthropic(contents: Content[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const c of contents) {
    const role: 'user' | 'assistant' = c.role === 'model' ? 'assistant' : 'user';
    const blocks = (c.parts ?? []).flatMap(convertPart);
    if (blocks.length > 0) out.push({ role, content: blocks });
  }
  return out;
}

function convertPart(p: Part): AnthropicContentBlock[] {
  if (typeof p.text === 'string' && p.text.length > 0) {
    return [{ type: 'text', text: p.text }];
  }
  if (p.functionCall) {
    return [{
      type: 'tool_use',
      id: p.functionCall.id ?? randomUUID(),
      name: p.functionCall.name ?? '',
      input: (p.functionCall.args ?? {}) as Record<string, unknown>,
    }];
  }
  if (p.functionResponse) {
    const resp = p.functionResponse.response ?? {};
    const isError = typeof resp === 'object' && resp != null && 'error' in (resp as Record<string, unknown>);
    return [{
      type: 'tool_result',
      tool_use_id: p.functionResponse.id ?? '',
      content: typeof resp === 'string' ? resp : JSON.stringify(resp),
      ...(isError ? { is_error: true } : {}),
    }];
  }
  // Other Part shapes (inlineData, fileData, executableCode, …) are not
  // supported — Claude's Messages API only handles text + tool blocks.
  return [];
}

function collectTools(req: LlmRequest): AnthropicTool[] {
  const out: AnthropicTool[] = [];
  for (const t of req.config?.tools ?? []) {
    // Skip Gemini-specific tools (googleSearch, codeExecution, …) — they
    // have no Anthropic equivalent and would 400 the upstream.
    if (!('functionDeclarations' in t) || !t.functionDeclarations) continue;
    for (const fd of t.functionDeclarations as FunctionDeclaration[]) {
      const schema = (fd.parametersJsonSchema as Record<string, unknown> | undefined)
        ?? convertGenaiSchemaToJsonSchema(fd.parameters)
        ?? { type: 'object', properties: {} };
      out.push({
        name: fd.name ?? '',
        description: fd.description ?? '',
        input_schema: schema,
      });
    }
  }
  return out;
}

/**
 * Best-effort conversion of `@google/genai` Schema → JSON Schema. ADK
 * normalizes most tool inputs into the OpenAPI Schema dialect; Anthropic
 * accepts standard JSON Schema. The shapes overlap heavily — we strip
 * the Gemini-only enum cases and downcase the type field.
 */
function convertGenaiSchemaToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') {
      out.type = v.toLowerCase();
    } else if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = convertGenaiSchemaToJsonSchema(pv) ?? pv;
      }
      out.properties = props;
    } else if (k === 'items') {
      out.items = convertGenaiSchemaToJsonSchema(v) ?? v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Translation: Anthropic response → ADK LlmResponse
// ───────────────────────────────────────────────────────────────────────

function convertAnthropicMessageToLlmResponse(msg: AnthropicMessageResponse): LlmResponse {
  const parts: Part[] = msg.content.map(toGenaiPart).filter((p): p is Part => p !== null);
  return {
    content: { role: 'model', parts },
    finishReason: mapStopReason(msg.stop_reason),
    usageMetadata: {
      promptTokenCount: msg.usage.input_tokens,
      candidatesTokenCount: msg.usage.output_tokens,
      totalTokenCount: msg.usage.input_tokens + msg.usage.output_tokens,
      cachedContentTokenCount: msg.usage.cache_read_input_tokens,
    },
    turnComplete: true,
  } as LlmResponse;
}

function toGenaiPart(block: AnthropicContentBlock): Part | null {
  if (block.type === 'text') {
    return { text: block.text };
  }
  if (block.type === 'tool_use') {
    return {
      functionCall: {
        id: block.id,
        name: block.name,
        args: block.input,
      },
    };
  }
  // tool_result blocks would only appear in user messages; we never
  // generate them from the assistant side.
  return null;
}

function mapStopReason(reason: AnthropicMessageResponse['stop_reason']): string {
  // ADK uses Gemini's FinishReason enum strings ("STOP", "MAX_TOKENS",
  // …). We approximate so downstream telemetry sees consistent values.
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'STOP';
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'tool_use':
      // No Gemini equivalent — closest is STOP since Runner stops here
      // to dispatch the tool. Keep the original for clarity.
      return 'STOP';
  }
}

// ───────────────────────────────────────────────────────────────────────
// SSE → LlmResponse
// ───────────────────────────────────────────────────────────────────────

interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function* parseAnthropicSseToLlmResponse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<LlmResponse, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  let stopReason: AnthropicMessageResponse['stop_reason'] = 'end_turn';
  const blocks: AnthropicContentBlock[] = [];
  // For each `index`, accumulate the raw payload so we can yield a
  // single LlmResponse at end-of-stream. Anthropic streams partial
  // arguments for tool_use as `input_json_delta` chunks; we collect them
  // and parse once on `content_block_stop`.
  const partialJson = new Map<number, string>();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt = parseSseFrame(frame);
      if (!evt) continue;

      switch (evt.event) {
        case 'message_start': {
          const m = (evt.data.message ?? {}) as Partial<AnthropicMessageResponse>;
          if (m.usage) usage = { ...usage, ...m.usage };
          break;
        }
        case 'content_block_start': {
          const i = evt.data.index as number;
          const block = evt.data.content_block as AnthropicContentBlock;
          blocks[i] = block;
          if (block.type === 'tool_use') partialJson.set(i, '');
          break;
        }
        case 'content_block_delta': {
          const i = evt.data.index as number;
          const delta = evt.data.delta as { type: string; text?: string; partial_json?: string };
          if (delta.type === 'text_delta' && delta.text) {
            const b = blocks[i];
            if (b && b.type === 'text') b.text += delta.text;
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            partialJson.set(i, (partialJson.get(i) ?? '') + delta.partial_json);
          }
          break;
        }
        case 'content_block_stop': {
          const i = evt.data.index as number;
          const b = blocks[i];
          const json = partialJson.get(i);
          if (b && b.type === 'tool_use' && json !== undefined) {
            try {
              b.input = json.length > 0 ? JSON.parse(json) : {};
            } catch {
              b.input = { _raw: json };
            }
          }
          break;
        }
        case 'message_delta': {
          const d = evt.data as { delta?: { stop_reason?: AnthropicMessageResponse['stop_reason'] }; usage?: Partial<AnthropicUsage> };
          if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
          if (d.usage) usage = { ...usage, ...d.usage };
          break;
        }
        case 'message_stop':
          // Final frame — yield once with the aggregated content.
          break;
        case 'error': {
          const err = evt.data.error as { type?: string; message?: string } | undefined;
          // Anthropic mid-stream `overloaded_error` / `rate_limit_error`
          // / `api_error` map to retryable UpstreamErrors so the
          // dashboard can chain-fallback to another provider.
          const type = err?.type ?? 'unknown';
          const message = err?.message ?? '';
          const retryable = /overloaded|rate.?limit|api_error|insufficient/i.test(`${type} ${message}`);
          throw new UpstreamError(retryable ? 503 : 500, `${type}: ${message}`, { provider: 'anthropic', retryable });
        }
      }
    }
  }

  yield convertAnthropicMessageToLlmResponse({
    id: '',
    type: 'message',
    role: 'assistant',
    model: '',
    content: blocks.filter((b): b is AnthropicContentBlock => b !== undefined),
    stop_reason: stopReason,
    usage,
  });
}

function parseSseFrame(frame: string): AnthropicSseEvent | null {
  let event = '';
  let dataLine = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLine += line.slice(5).trim();
    }
  }
  if (!event || !dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Misc helpers
// ───────────────────────────────────────────────────────────────────────

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}
