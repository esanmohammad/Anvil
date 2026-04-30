/**
 * Phase 1 of the agent-manager consolidation — type surface for the unified
 * agent-lifecycle layer.
 *
 * `AgentSession` (one logical agent, EventEmitter, supports `sendInput` for
 * resume) and `AgentSessionRegistry` (Map<id, AgentSession>) replace the two
 * pre-existing `AgentManager` classes (dashboard's stateful one and
 * agent-core's single-shot one) — see `AGENT-MANAGER-CONSOLIDATION-ADR.md`.
 *
 * This file is types-only. Implementation lands in Phase 2; Phase 1's
 * acceptance criterion is "callers can rename their imports and the project
 * still type-checks" (which is a no-op until imports flip in Phase 4/5).
 */

// ────────────────────────────────────────────────────────────────────────────
// Snapshot of one agent's runtime state
// ────────────────────────────────────────────────────────────────────────────

/**
 * The 5-state lifecycle a single agent passes through. Dashboard's existing
 * `AgentState.status` shape, lifted verbatim per ADR D2.
 *
 * - `pending` — created but not yet started (rare; only between `spawn()`
 *   call and constructor return).
 * - `running` — adapter process is live; can be killed or sent input.
 * - `done` — adapter exited cleanly with a final result.
 * - `error` — adapter failed with a typed error.
 * - `killed` — caller invoked `kill()` while the adapter was running.
 */
export type AgentSessionStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'killed';

/**
 * One activity event emitted by an adapter — tool use, thinking block, or
 * a text-only completion segment. The dashboard surfaces these in the UI;
 * cli ignores them. Lifted verbatim from
 * `dashboard/server/agent-process.ts:AgentActivity`.
 */
export interface AgentActivity {
  id: string;
  kind: 'tool_use' | 'thinking' | 'text';
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
 *
 * Note: this type is intentionally *additive* over `InvokeUsage` rather than
 * a rename — the streaming pipeline still emits `InvokeUsage`; the session
 * layer aggregates into `CostInfo`.
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
 * Snapshot of one session's state. Returned by `AgentSessionRegistry.get(id)`
 * and `AgentSession.getState()`. The `output` field is the running text
 * accumulator (capped at 500KB, tail-kept).
 */
export interface AgentSessionState {
  id: string;
  name: string;
  persona: string;
  sessionId: string;
  model: string;
  status: AgentSessionStatus;
  cost: CostInfo;
  output: string;
  activities: AgentActivity[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Launch shape — the unified `SessionSpec`
// ────────────────────────────────────────────────────────────────────────────

/**
 * The canonical agent-launch shape. Replaces both:
 *   - dashboard's `SpawnConfig` (stateful flow), and
 *   - agent-core's `AgentProcessConfig` (cli single-shot flow).
 *
 * Field-mapping table is in ADR § 4. The two precursor types become
 * deprecated aliases that map structurally to `SessionSpec` (Phase 1
 * back-compat); they are removed in Phase 4 (dashboard) and Phase 6
 * (agent-core).
 */
export interface SessionSpec {
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
  /** Working directory for the adapter process. Canonical name (was
   *  `workingDir` in agent-core's legacy `AgentProcessConfig`). */
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
}

// ────────────────────────────────────────────────────────────────────────────
// EventEmitter event shapes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Events emitted by a single `AgentSession`. Mirrors dashboard's
 * `AgentProcessEvents` exactly (5 events) so consumer wiring is unchanged
 * once Phase 4 flips the imports.
 */
export interface AgentSessionEvents {
  content: (text: string) => void;
  activity: (activity: AgentActivity) => void;
  result: (data: { result: string; cost: CostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

/**
 * Events emitted by the registry that owns sessions. Mirrors dashboard's
 * `AgentManagerEvents` exactly (4 events) per ADR D2.
 */
export interface AgentSessionRegistryEvents {
  'agent-output': (data: { agentId: string; chunk: string }) => void;
  'agent-activity': (data: { agentId: string; activity: AgentActivity }) => void;
  'agent-done': (data: { agent: AgentSessionState }) => void;
  'agent-error': (data: { agentId: string; error: string }) => void;
}

// ────────────────────────────────────────────────────────────────────────────
// Hooks — cost ledger + checkpoint cache integration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Cost hook — invoked after every agent result so a ledger (dashboard's
 * `CostLedger` and/or agent-core's `SpendLedger`) can record token usage
 * and trigger breach flows. Fire-and-forget; hook impls must never throw
 * back into the registry.
 *
 * Lifted verbatim from `dashboard/server/agent-manager.ts:AgentCostHook`.
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
 * output, the registry synthesizes a done-event and skips the spawn.
 *
 * Lifted verbatim from `dashboard/server/agent-manager.ts:AgentCheckpointHook`.
 * The cache itself moves to `@anvil/agent-core/checkpoint/` in Phase 3.
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
 * Thrown when `AgentSession.sendInput()` is called against an adapter whose
 * `LanguageModel.capabilities.sessionResume === false`. Locked by ADR D5.
 */
export class SessionResumeNotSupportedError extends Error {
  readonly provider: string;
  readonly model: string;
  constructor(provider: string, model: string) {
    super(
      `Adapter '${provider}' (model '${model}') does not support session resume — ` +
        `cannot sendInput on an existing AgentSession.`,
    );
    this.name = 'SessionResumeNotSupportedError';
    this.provider = provider;
    this.model = model;
  }
}

/**
 * Thrown when the registry can't find a session by id (e.g. `kill('unknown')`).
 */
export class AgentSessionNotFoundError extends Error {
  readonly agentId: string;
  constructor(agentId: string) {
    super(`Agent session ${agentId} not found`);
    this.name = 'AgentSessionNotFoundError';
    this.agentId = agentId;
  }
}
