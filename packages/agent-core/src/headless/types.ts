/**
 * Headless `runAgent` entry — types are Inspect-AI-compatible per ADR §5/§6/§7.
 *
 * Schema is locked. Future eval harnesses (Inspect AI, SWE-bench runners,
 * custom benchmark scripts) consume `AgentTrajectory` directly without
 * conversion. If their contract drifts, write an adapter — don't refactor
 * this shape.
 */

import type { LanguageModel, ToolSchema } from '../types.js';

export interface WorkspaceConfig {
  /** Absolute path to the project workspace (where mcp.json + .claude/skills/ live). */
  rootDir: string;
  /** Optional override for factory.yaml path (forwarded to subprocess adapters). */
  factoryYamlPath?: string;
  /** Extra env vars passed to subprocess adapters (CLI providers). */
  env?: Record<string, string>;
}

export interface AgentTask {
  /** Human-readable task statement. Becomes the first user message. */
  prompt: string;

  /** Optional system-prompt prefix (rendered before the skills block). */
  systemPrompt?: string;

  /**
   * Allowed built-in tools. Intersected with skill `allowed-tools`
   * constraints. MCP-discovered tools are added unconditionally.
   */
  allowedTools?: string[];

  /** Model identifier ('claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro', ...). */
  model: string;

  /** Provider hint: 'anthropic-cli' | 'anthropic-api' | 'openai-api' | ... */
  provider?: string;

  /** Max tokens per assistant turn. */
  maxTokens?: number;

  /** Sampling temperature. */
  temperature?: number;

  /**
   * Optional task ID for trace correlation — surfaced as `anvil.task_id`
   * on every `gen_ai.invoke` span emitted within this run.
   */
  taskId?: string;
}

export interface TrajectoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Tool name when role === 'tool'. */
  name?: string;
  /** Originating assistant tool_call id when role === 'tool'. */
  toolCallId?: string;
}

export interface TrajectoryToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface TrajectoryUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AgentTrajectory {
  messages: TrajectoryMessage[];
  toolCalls: TrajectoryToolCall[];
  /** Concrete model the run resolved to (post-fallback). */
  model: string;
  /** Aggregated across every LLM call in the run. */
  usage: TrajectoryUsage;
  /** Aggregated USD cost across every LLM call. */
  costUsd: number;
  /** Final assistant text (after the last non-tool turn). */
  finalAnswer: string;
  finishReason: 'end' | 'tool-use' | 'length' | 'error';
  /** Populated only when finishReason === 'error'. */
  error?: string;
  durationMs: number;
}

/**
 * Built-in tool dispatcher. Receives the bare tool name + arguments + the
 * workspace for cwd context; returns whatever the tool produced (any JSON-
 * serializable value). Throws on tool failure (caught by the loop and
 * surfaced as `tool` message + `error` on the trajectory tool call).
 */
export type BuiltInToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
  workspace: WorkspaceConfig,
) => Promise<unknown>;

export interface RunAgentOptions {
  /**
   * Required: the LanguageModel that runs the inference loop. As of
   * 2026-04-29, no agent-core adapter implements `LanguageModel` natively
   * (per observability ADR §3.4); callers must inject one. Tests use a
   * mock; production callers will inject the bridge once it ships.
   */
  model: LanguageModel;

  /** Built-in tools available to the agent (default: none). */
  builtInTools?: ToolSchema[];

  /** Dispatcher for built-in tool calls (default: throws "no dispatcher"). */
  builtInDispatch?: BuiltInToolDispatcher;

  /** Hard cap on tool-call iterations (default: 25 per ADR §6.1). */
  maxToolLoopIterations?: number;

  /** Wall-clock timeout per `runAgent` call in ms (default: 600_000). */
  timeoutMs?: number;
}
