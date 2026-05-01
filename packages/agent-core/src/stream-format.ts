/**
 * Anvil Stream Format helpers.
 *
 * Every non-Claude adapter uses these functions to produce NDJSON output that
 * matches `claude --output-format stream-json`, so all existing parsers
 * (run-feature.ts, agent-process.ts, spawn.ts) work without modification.
 *
 * Line format reference:
 *   Content:  {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   Tool use: {"type":"assistant","message":{"content":[{"type":"tool_use","name":"...","input":{...}}]}}
 *   Thinking: {"type":"assistant","message":{"content":[{"type":"thinking","text":"..."}]}}
 *   Result:   {"type":"result","result":"...","total_cost_usd":0.123,"usage":{...},"duration_ms":5000,"session_id":"..."}
 */

// ---------------------------------------------------------------------------
// Message shape interfaces
// ---------------------------------------------------------------------------

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  /** Pairing id consumed by `LanguageModelBridge` to match tool_result. */
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface UserMessage {
  type: 'user';
  message: {
    content: ToolResultContentBlock[];
  };
}

export interface ThinkingContentBlock {
  type: 'thinking';
  text: string;
}

export type ContentBlock = TextContentBlock | ToolUseContentBlock | ThinkingContentBlock;

export interface AssistantMessage {
  type: 'assistant';
  message: {
    content: ContentBlock[];
  };
}

export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ResultMessage {
  type: 'result';
  result: string;
  total_cost_usd: number;
  usage: ResultUsage;
  duration_ms: number;
  session_id?: string;
}

export type StreamLine = AssistantMessage | UserMessage | ResultMessage;

// ---------------------------------------------------------------------------
// Emit helpers — each writes exactly one NDJSON line (JSON + '\n')
// ---------------------------------------------------------------------------

/** Emit a text content block. */
export function emitContent(out: NodeJS.WritableStream, text: string): void {
  const line: AssistantMessage = {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  };
  out.write(JSON.stringify(line) + '\n');
}

/**
 * Emit a tool_use content block.
 *
 * `id` is the pairing identifier the bridge uses to match this call to
 * its eventual `tool_result`. Adapters that drive their own agentic
 * loop (Ollama, future OpenAI/Gemini agentic paths) MUST pass an id;
 * legacy single-shot callers may omit it.
 */
export function emitToolUse(
  out: NodeJS.WritableStream,
  name: string,
  input: Record<string, unknown>,
  id?: string,
): void {
  const block: ToolUseContentBlock = id !== undefined
    ? { type: 'tool_use', id, name, input }
    : { type: 'tool_use', name, input };
  const line: AssistantMessage = {
    type: 'assistant',
    message: { content: [block] },
  };
  out.write(JSON.stringify(line) + '\n');
}

/**
 * Emit a tool_result content block (user-role message).
 *
 * Used by adapters that own their agentic loop and need to feed tool
 * outputs back to the model. `LanguageModelBridge` pairs `tool_use_id`
 * to the open span and closes it on receipt — same pairing logic as
 * Claude CLI's native stream.
 */
export function emitToolResult(
  out: NodeJS.WritableStream,
  opts: { toolUseId: string; content: string; isError?: boolean },
): void {
  const block: ToolResultContentBlock = {
    type: 'tool_result',
    tool_use_id: opts.toolUseId,
    content: opts.content,
    ...(opts.isError !== undefined ? { is_error: opts.isError } : {}),
  };
  const line: UserMessage = { type: 'user', message: { content: [block] } };
  out.write(JSON.stringify(line) + '\n');
}

/** Emit a thinking content block. */
export function emitThinking(out: NodeJS.WritableStream, text: string): void {
  const line: AssistantMessage = {
    type: 'assistant',
    message: {
      content: [{ type: 'thinking', text }],
    },
  };
  out.write(JSON.stringify(line) + '\n');
}

/** Emit the final result line. */
export function emitResult(
  out: NodeJS.WritableStream,
  opts: {
    text: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    sessionId?: string;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): void {
  const line: ResultMessage = {
    type: 'result',
    result: opts.text,
    total_cost_usd: opts.costUsd,
    usage: {
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cache_read_input_tokens: opts.cacheReadTokens ?? 0,
      cache_creation_input_tokens: opts.cacheWriteTokens ?? 0,
    },
    duration_ms: opts.durationMs,
    ...(opts.sessionId != null ? { session_id: opts.sessionId } : {}),
  };
  out.write(JSON.stringify(line) + '\n');
}
