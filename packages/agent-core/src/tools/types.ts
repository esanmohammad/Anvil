/**
 * Built-in tool executor surface used by non-Claude adapters that need
 * to drive an agentic loop themselves (Claude CLI ships its own tool
 * runtime; everything else routes through this).
 *
 * Schemas are JSON Schema and OpenAI-tool-compatible — Ollama, OpenAI,
 * Gemini, and OpenRouter all accept this shape with minor envelope
 * differences handled by each adapter.
 */

import type { ToolCall, ToolSchema } from '../types.js';

export interface ExecCtx {
  /** Absolute workingDir; every path arg must resolve inside this directory. */
  workingDir: string;
  /** Cancels long-running operations (bash, large file ops) when fired. */
  abortSignal: AbortSignal;
}

export interface ToolResult {
  /** Free-form content the model sees. Truncated by the adapter if needed. */
  content: string;
  /** True when the call failed; the adapter still feeds it back so the
   *  model can recover instead of getting silently stuck. */
  isError: boolean;
}

export interface ToolExecutor {
  /**
   * Schemas the adapter MAY advertise to the model. Permission-filtered
   * BEFORE this call returns so the model never learns about denied tools.
   */
  listSchemas(): ToolSchema[];

  /**
   * Execute a single tool call. Implementations must:
   *   1. Re-check permissions (defense in depth).
   *   2. Re-validate path arguments against ctx.workingDir.
   *   3. Honor ctx.abortSignal for any long-running work.
   *   4. NEVER throw — surface failures via { isError: true, content }.
   */
  execute(call: ToolCall, ctx: ExecCtx): Promise<ToolResult>;
}

/**
 * Permission classes for built-in tools. Stage policy maps stage name →
 * set of allowed classes. The executor filters schemas + rejects calls
 * whose tool falls outside the set.
 */
export type ToolClass = 'read' | 'write' | 'exec';
