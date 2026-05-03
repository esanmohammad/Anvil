/**
 * Inspect-AI-compatible types for `collectTrajectory` (and previously
 * `runAgent`).
 *
 * Schema is locked. External eval harnesses (Inspect AI, SWE-bench
 * runners, custom benchmark scripts) consume `AgentTrajectory` directly
 * without conversion. If their contract drifts, write an adapter — don't
 * refactor this shape.
 *
 * Per AGENT-PROCESS-CONSOLIDATION-ADR §C2 these moved from `src/headless/
 * types.ts` to live alongside `AgentProcess`. The `src/headless/types.ts`
 * module still re-exports them as a thin shim until Phase 5 deletes the
 * `headless/` directory.
 */

export interface WorkspaceConfig {
  /** Absolute path to the project workspace (where `mcp.json` + `.claude/skills/` live). */
  rootDir: string;
  /** Optional override for `factory.yaml` path (forwarded to subprocess adapters). */
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

  /** Model identifier (e.g. 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'). */
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
