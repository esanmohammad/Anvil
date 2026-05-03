/**
 * Headless `runAgent` entry types — kept here as a thin re-export shim.
 *
 * Per AGENT-PROCESS-CONSOLIDATION-ADR §C2 the canonical location for the
 * Inspect-AI-compatible types is now `agent/session/headless-types.ts`.
 * Phase 5 of the consolidation deletes this `headless/` directory; until
 * then, this shim keeps the existing `runAgent` runner compiling without
 * duplicate type declarations.
 */

import type { LanguageModel, ToolSchema } from '../types.js';
import type { WorkspaceConfig } from '../agent/session/headless-types.js';

// Re-export the canonical types so external imports
// (`@anvil/agent-core/headless`) keep working until Phase 5.
export type {
  AgentTask,
  AgentTrajectory,
  TrajectoryMessage,
  TrajectoryToolCall,
  TrajectoryUsage,
  WorkspaceConfig,
} from '../agent/session/headless-types.js';

/**
 * Built-in tool dispatcher. Receives the bare tool name + arguments + the
 * workspace for cwd context; returns whatever the tool produced (any JSON-
 * serializable value). Throws on tool failure (caught by the loop and
 * surfaced as `tool` message + `error` on the trajectory tool call).
 *
 * Used only by the legacy `runAgent` runner; removed in Phase 5.
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
   * (per observability ADR §3.4); callers must inject one.
   *
   * Used only by the legacy `runAgent` runner; removed in Phase 5.
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
