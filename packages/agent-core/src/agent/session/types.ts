/**
 * Type surface for `@esankhan3/anvil-agent-core`'s agent-lifecycle layer.
 *
 * `AgentProcess` (one logical agent, EventEmitter, supports `sendInput` for
 * resume) and `AgentManager` (Map<id, AgentProcess>) are the canonical
 * agent-runtime types — agent-core is the source of truth. Dashboard and
 * cli both consume these directly without aliasing.
 *
 * History: an earlier extract phase shipped a single-shot `AgentManager`
 * class at `agent/agent-manager.ts` that never got wired up. The current
 * stateful surface lifted dashboard's pre-Phase-4 `AgentManager` into this
 * package and reclaimed the canonical name. See
 * `AGENT-MANAGER-CONSOLIDATION-ADR.md`.
 */

// ────────────────────────────────────────────────────────────────────────────
// Snapshot of one agent's runtime state
// ────────────────────────────────────────────────────────────────────────────

/**
 * The 5-state lifecycle a single agent passes through.
 *
 * - `pending` — created but not yet started (rare; only between `spawn()`
 *   call and constructor return).
 * - `running` — adapter process is live; can be killed or sent input.
 * - `done` — adapter exited cleanly with a final result.
 * - `error` — adapter failed with a typed error.
 * - `killed` — caller invoked `kill()` while the adapter was running.
 */
export type AgentStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'killed';

/**
 * One activity event emitted by an adapter — tool use, thinking block, or
 * a text-only completion segment. Dashboard surfaces these in the UI; cli
 * ignores them.
 */
export interface AgentActivity {
  id: string;
  kind: 'tool_use' | 'thinking' | 'text' | 'tool_result';
  tool?: string;
  summary: string;
  content?: string;
  timestamp: number;
}

/**
 * Cost / usage block — populated when the adapter reports its `usage` event.
 * `agent-core/types.ts:InvokeUsage` is the *streaming* analog (token counts
 * only); `CostInfo` adds USD + durationMs + the provider-side `stopReason`
 * so callers can detect output truncation.
 */
export interface CostInfo {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  /** Provider stop reason — `'max_tokens'` indicates output truncation. */
  stopReason?: string;
}

/**
 * Snapshot of one agent's state. Returned by `AgentManager.getAgent(id)`
 * and `AgentProcess.getState()`. The `output` field is the running text
 * accumulator (capped at 500KB, tail-kept).
 */
export interface AgentState {
  id: string;
  name: string;
  persona: string;
  sessionId: string;
  model: string;
  status: AgentStatus;
  cost: CostInfo;
  /**
   * Streaming transcript — accumulates every text chunk emitted during the
   * run (exploration narrative, tool-read paraphrases, partial drafts).
   * Use this for the Activity tab; do NOT use for the canonical artifact.
   * Capped at 500KB, tail-kept.
   */
  output: string;
  /**
   * The single canonical artifact text — set once when the adapter fires
   * its terminal `result` event. Never accumulates; never includes the
   * agent's exploration narrative. This is what should land on disk and
   * in the Raw tab. Undefined while the run is still in flight or the
   * adapter never reached a `result` frame (Step 1's empty-throw makes
   * the latter loud rather than silent).
   *
   * Optional so existing test fixtures and pre-finalAnswer cached states
   * don't need migration; consumers always fall back to `output`.
   */
  finalAnswer?: string;
  activities: AgentActivity[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Launch shape — `SpawnConfig`
// ────────────────────────────────────────────────────────────────────────────

/**
 * The canonical agent-launch shape. Passed to `AgentManager.spawn()`.
 */
export interface SpawnConfig {
  /** Display name — appears in dashboard UI and logs. */
  name: string;
  /** Persona id — drives prompt-template selection (e.g. `'engineer'`). */
  persona: string;
  /** Project key — used for cost grouping + checkpoint cache namespacing. */
  project: string;
  /** Pipeline stage name (e.g. `'clarify'`, `'build'`). */
  stage: string;
  /** User-side prompt the agent runs against. */
  prompt: string;
  /** Model id (e.g. `'claude-3-5-sonnet'`, `'gpt-4'`). */
  model: string;
  /** Working directory for the adapter process. */
  cwd: string;
  /** Optional system prompt prefix injected before the user prompt. */
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  /** Output-token ceiling, forwarded to adapters whose
   *  `capabilities.maxOutputTokens === true`. */
  maxOutputTokens?: number;
  /** Pipeline runId — groups cost/checkpoint records. */
  runId?: string;
  /** Stable cross-retry id for the checkpoint cache. Defaults to `runId`. */
  runFamily?: string;
  /** Restart policy on subprocess crash. cli sets `{ maxAttempts: 2 }` by
   *  default; dashboard sets `{ maxAttempts: 0 }` (no auto-restart). */
  restart?: { maxAttempts: number };
  /** Per-call timeout in ms. `0` = no timeout (dashboard default). cli
   *  sets it from per-stage defaults. */
  timeoutMs?: number;
  /** Override the binary used to spawn the adapter. Defaults to
   *  `ANVIL_AGENT_CMD` env / `'claude'`. Used by tests. */
  binaryPath?: string;
  /** Escape hatch for arbitrary CLI args. cli uses; dashboard never sets. */
  args?: string[];
  /**
   * Workspace root for skills + MCP discovery. Distinct from `cwd` (the
   * subprocess working directory) so tests can run with cwd === '/tmp'
   * while loading skills from the repo root. When undefined, skills + MCP
   * are skipped (back-compat with existing spawn sites).
   *
   * Per AGENT-PROCESS-CONSOLIDATION-ADR §C4.
   */
  workspaceDir?: string;
  /**
   * Wave 5 — optional callback enabling the `recall_memory` builtin.
   * When wired AND `'recall_memory'` is in `allowedTools`, the agent
   * can search project memory mid-run. Bounded by a 3-call budget
   * enforced inside BuiltinToolExecutor. Callers (dashboard) wire a
   * project-scoped `hybridSearch` here.
   */
  recallMemory?: (
    query: string,
    opts: { kind?: string; subtype?: string; limit?: number },
  ) => Promise<string>;
}

// ────────────────────────────────────────────────────────────────────────────
// EventEmitter event shapes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Events emitted by a single `AgentProcess`. 5-event surface piped through
 * from the underlying `AgentAdapter`.
 */
export interface AgentProcessEvents {
  content: (text: string) => void;
  activity: (activity: AgentActivity) => void;
  result: (data: { result: string; cost: CostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

/**
 * Events emitted by `AgentManager`. 4-event registry-level surface (the
 * dashboard's WebSocket layer subscribes to these to broadcast to clients).
 */
export interface AgentManagerEvents {
  'agent-output': (data: { agentId: string; chunk: string }) => void;
  'agent-activity': (data: { agentId: string; activity: AgentActivity }) => void;
  'agent-done': (data: { agent: AgentState }) => void;
  'agent-error': (data: { agentId: string; error: string }) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Hooks — cost ledger + checkpoint cache integration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Cost hook — invoked after every agent result so a ledger (dashboard's
 * `CostLedger` and/or agent-core's `SpendLedger`) can record token usage
 * and trigger breach flows. Fire-and-forget; hook impls must never throw
 * back into the manager.
 */
export interface AgentCostHook {
  (info: {
    runId?: string;
    project?: string;
    stage?: string;
    agent: string;
    persona: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    usd: number;
  }): void | Promise<void>;
}

/**
 * Checkpoint hook — consulted BEFORE spawning. If it returns a cached
 * output, the manager synthesizes a done-event and skips the spawn.
 */
export interface AgentCheckpointHook {
  lookup(input: {
    project: string;
    stage: string;
    persona: string;
    model: string;
    prompt: string;
    runFamily?: string;
  }): { hit: true; output: string; cost?: CostInfo } | { hit: false };

  record?(input: {
    project: string;
    stage: string;
    persona: string;
    model: string;
    prompt: string;
    runFamily?: string;
    output: string;
    cost: CostInfo;
  }): void;
}

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when `AgentProcess.sendInput()` is called against an adapter whose
 * `LanguageModel.capabilities.sessionResume === false`.
 */
export class SessionResumeNotSupportedError extends Error {
  readonly provider: string;
  readonly model: string;
  constructor(provider: string, model: string) {
    super(
      `Adapter '${provider}' (model '${model}') does not support session resume — ` +
        `cannot sendInput on an existing AgentProcess.`,
    );
    this.name = 'SessionResumeNotSupportedError';
    this.provider = provider;
    this.model = model;
  }
}

/**
 * Thrown when `AgentManager` can't find an agent by id (e.g. `kill('unknown')`).
 */
export class AgentNotFoundError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = 'AgentNotFoundError';
    this.agentId = agentId;
  }
}
