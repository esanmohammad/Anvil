/**
 * `AgentAdapter` — minimal adapter contract `AgentSession` consumes.
 *
 * Mirrors the public surface of dashboard's `BaseAdapter` (EventEmitter +
 * `start()` / `kill()` / `setMaxOutputTokens()`). Defining it in agent-core
 * lets both consumers wire their own adapters:
 *
 *   - Dashboard injects its existing `BaseAdapter`-derived adapters
 *     (claude / openai / etc.) which already satisfy this shape.
 *   - cli (Phase 5) injects a thin wrapper that drives agent-core's
 *     `LanguageModel.invokeStream()` and re-emits the same 5 events.
 *
 * The structural interface (vs a class) avoids forcing consumers to inherit
 * from agent-core just to plug in.
 */

import type { EventEmitter } from 'node:events';
import type { AgentActivity, CostInfo, SpawnConfig } from './types.js';

/**
 * The 5 events an adapter emits during a run. Same shape as dashboard's
 * `AdapterEvents` (and dashboard's `AgentProcessEvents`).
 */
export interface AgentAdapterEvents {
  content: (text: string) => void;
  activity: (activity: AgentActivity) => void;
  result: (data: { result: string; cost: CostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

/**
 * Public surface of an adapter `AgentSession` knows how to drive. We depend
 * structurally on `EventEmitter` so consumers can subclass `EventEmitter`
 * directly (the dashboard already does).
 */
export interface AgentAdapter extends EventEmitter {
  /** Begin running. May spawn a subprocess, open a stream, etc. */
  start(): void;
  /** Stop running and release resources. Idempotent. */
  kill(signal?: string): void;
  /** Optional output-token ceiling. Adapters that don't honor it ignore it. */
  setMaxOutputTokens?(n: number): void;
  readonly pid?: number;
  readonly killed?: boolean;
}

/**
 * Options forwarded to the adapter factory when `AgentSession` builds its
 * underlying adapter. Mirrors dashboard's `AgentProcessConfig` — a flattened
 * subset of `SpawnConfig` plus a `resume` flag.
 */
export interface AdapterRequest {
  prompt: string;
  model: string;
  sessionId: string;
  cwd: string;
  /** When true, the adapter resumes the prior session rather than starting fresh. */
  resume?: boolean;
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  maxOutputTokens?: number;
  /** Pipeline stage (e.g. 'requirements', 'build', 'spike'). Surfaces on
   *  every span and metric so dashboards can slice by stage. */
  stage?: string;
  /** Agent persona (e.g. 'analyst', 'engineer'). Same. */
  persona?: string;
  /** Project the spawn belongs to. */
  project?: string;
  /** Run id grouping multiple spawns into one logical pipeline run. */
  runId?: string;
  /** When true, the adapter routes the call through the LocalExecutor's
   *  single-slot FIFO. Set automatically by the SpawnConfig→AdapterRequest
   *  mapping when the resolved model has `exclusive_slot:true` in
   *  `~/.anvil/models.yaml`. */
  exclusiveSlot?: boolean;
  /** Workspace root forwarded from `SpawnConfig.workspaceDir`. Used by
   *  `defaultAdapterFactory` to discover skills + MCP. Per AGENT-PROCESS-
   *  CONSOLIDATION-ADR §C4. */
  workspaceDir?: string;
  /** Internal — populated by `defaultAdapterFactory` for the Claude path
   *  when an `mcp.json` is discovered under `workspaceDir`. The bridge
   *  forwards it to `ModelAdapterConfig.mcpConfigPath` so claude-cli
   *  reads it via `--mcp-config <path>`. Not user-facing. */
  claudeMcpConfigPath?: string;
  /** Internal — populated by `AgentProcess` once per session for non-Claude
   *  paths. The bridge wraps it into a `MergedToolExecutor` so the adapter's
   *  agentic loop can call MCP tools the same way it calls builtins. The
   *  pool is session-scoped so resume turns reuse already-connected
   *  servers. Not user-facing. */
  mcpPool?: McpClientPoolLike;
  /** Internal — callback fired by `MergedToolExecutor` whenever an MCP
   *  tool call starts/ends. Routed up to the agent's `activity` stream so
   *  the dashboard shows MCP work in the activity panel. */
  mcpProgress?: (ev: McpActivityEvent) => void;
  /** Wave 5 — memory recall callback. When the spawn site wires this
   *  AND `recall_memory` is in `allowedTools`, the executor advertises
   *  the tool to the agent. Caller (the dashboard) composes a
   *  project-scoped `hybridSearch` and returns the JSON the model sees.
   *  Bounded by a per-spawn budget enforced inside BuiltinToolExecutor. */
  recallMemory?: (
    query: string,
    opts: { kind?: string; subtype?: string; limit?: number },
  ) => Promise<string>;
}

/** Subset of `McpClientPool` consumed via `AdapterRequest`. Avoids a
 *  hard import cycle with `mcp/pool.ts` from this adapter type file. */
export interface McpClientPoolLike {
  hasServers(): boolean;
  discoverTools(): Promise<unknown[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  cancelInFlight(reason?: string): void;
  close(): Promise<void>;
  readonly failures: ReadonlyArray<{ server: string; reason: string }>;
}

/** Activity events surfaced from the MCP layer to the agent stream. */
export interface McpActivityEvent {
  kind: 'mcp-call-start' | 'mcp-call-end' | 'mcp-progress' | 'mcp-server-failed';
  serverName: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
  progress?: number;
  total?: number;
  message?: string;
}

/**
 * Factory the registry uses to construct adapters per spawn. Keeps the
 * adapter family out of agent-core's dependency graph.
 *
 * Consumers wire this once when constructing the registry:
 *
 *   const registry = new AgentSessionRegistry({
 *     adapterFactory: (req) => createAdapter(req),
 *   });
 */
export type AgentAdapterFactory = (req: AdapterRequest) => AgentAdapter;

/**
 * Convenience helper — constructs an `AdapterRequest` from a `SpawnConfig`
 * plus a generated session id.
 */
export function buildAdapterRequest(
  spec: SpawnConfig,
  sessionId: string,
  opts?: { resume?: boolean; cwdOverride?: string },
): AdapterRequest {
  return {
    prompt: spec.prompt,
    model: spec.model,
    sessionId,
    cwd: opts?.cwdOverride ?? spec.cwd,
    resume: opts?.resume,
    projectPrompt: spec.projectPrompt,
    permissionMode: spec.permissionMode,
    disallowedTools: spec.disallowedTools,
    allowedTools: spec.allowedTools,
    maxOutputTokens: spec.maxOutputTokens,
    stage: spec.stage,
    persona: spec.persona,
    project: spec.project,
    runId: spec.runId,
    workspaceDir: spec.workspaceDir,
    recallMemory: spec.recallMemory,
  };
}
