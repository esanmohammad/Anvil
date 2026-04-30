/**
 * `AgentSession` — one logical agent.
 *
 * Skeleton for Phase 1 of the agent-manager consolidation. The runtime
 * behavior (event piping, sendInput-via-resume, cost aggregation) lands in
 * Phase 2. This file exists so:
 *   1. Consumers can `import { AgentSession }` and tsc binds the symbol.
 *   2. The constructor signature is locked at the type level.
 *   3. Method signatures match dashboard's existing `AgentProcess` so the
 *      Phase 4 dashboard cutover is a pure rename.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentActivity,
  AgentSessionEvents,
  AgentSessionState,
  AgentSessionStatus,
  CostInfo,
  SessionSpec,
} from './types.js';

const PHASE_1_UNIMPLEMENTED =
  '[agent-core] AgentSession runtime lands in Phase 2 of the agent-manager consolidation; this is the Phase 1 type skeleton.';

export class AgentSession extends EventEmitter {
  readonly id: string;
  readonly spec: SessionSpec;
  protected state: AgentSessionState;

  constructor(spec: SessionSpec, opts?: { id?: string }) {
    super();
    this.spec = spec;
    this.id = opts?.id ?? spec.name;
    this.state = createPendingState(spec, this.id);
  }

  // ── Typed event helpers ──────────────────────────────────────────────

  override on<K extends keyof AgentSessionEvents>(
    event: K,
    listener: AgentSessionEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AgentSessionEvents>(
    event: K,
    ...args: Parameters<AgentSessionEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ── Lifecycle (Phase 2) ──────────────────────────────────────────────

  /** Start the underlying adapter process. */
  start(): void {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }

  /** Send input to a running session — spawns a new resume process per ADR D5. */
  sendInput(_text: string): void {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }

  /** Kill the underlying adapter process. */
  kill(_signal?: NodeJS.Signals): void {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }

  // ── State queries ────────────────────────────────────────────────────

  /** Read-only snapshot of the session's runtime state. */
  getState(): AgentSessionState {
    return this.state;
  }

  get status(): AgentSessionStatus {
    return this.state.status;
  }

  get cost(): CostInfo {
    return this.state.cost;
  }

  get activities(): AgentActivity[] {
    return this.state.activities;
  }

  get output(): string {
    return this.state.output;
  }
}

// ── Factory helpers ────────────────────────────────────────────────────

function createPendingState(
  spec: SessionSpec,
  id: string,
): AgentSessionState {
  return {
    id,
    name: spec.name,
    persona: spec.persona,
    sessionId: id,
    model: spec.model,
    status: 'pending',
    cost: emptyCost(),
    output: '',
    activities: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export function emptyCost(): CostInfo {
  return {
    totalUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
  };
}
