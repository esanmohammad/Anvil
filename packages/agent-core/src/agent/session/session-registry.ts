/**
 * `AgentSessionRegistry` — tracks many concurrent `AgentSession`s.
 *
 * Skeleton for Phase 1 of the agent-manager consolidation. The runtime
 * behavior (Map<id, session>, spawn fanout, sendInput dispatch, kill, cost
 * + checkpoint hooks, event re-emission) lands in Phase 2.
 *
 * Replaces dashboard's `AgentManager` (444 LOC) and supersedes agent-core's
 * existing single-shot `AgentManager` per ADR D2.
 */

import { EventEmitter } from 'node:events';
import { AgentSession } from './session.js';
import type {
  AgentCheckpointHook,
  AgentCostHook,
  AgentSessionRegistryEvents,
  AgentSessionState,
  SessionSpec,
} from './types.js';

const PHASE_1_UNIMPLEMENTED =
  '[agent-core] AgentSessionRegistry runtime lands in Phase 2 of the agent-manager consolidation; this is the Phase 1 type skeleton.';

export class AgentSessionRegistry extends EventEmitter {
  protected sessions = new Map<string, AgentSession>();
  protected costHook: AgentCostHook | null = null;
  protected checkpointHook: AgentCheckpointHook | null = null;

  // ── Typed event helpers ──────────────────────────────────────────────

  override on<K extends keyof AgentSessionRegistryEvents>(
    event: K,
    listener: AgentSessionRegistryEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AgentSessionRegistryEvents>(
    event: K,
    ...args: Parameters<AgentSessionRegistryEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ── Hooks ────────────────────────────────────────────────────────────

  setCostHook(hook: AgentCostHook | null): void {
    this.costHook = hook;
  }

  setCheckpointHook(hook: AgentCheckpointHook | null): void {
    this.checkpointHook = hook;
  }

  // ── Spawn / state queries (Phase 2 fills the bodies) ─────────────────

  /**
   * Spawn a new session. Returns a synchronous snapshot of its state with
   * `status === 'pending'` (or `'done'` on a checkpoint cache hit).
   */
  spawn(_spec: SessionSpec): AgentSessionState {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }

  /**
   * Read-only snapshot of an agent's state, or `undefined` if unknown.
   */
  getAgent(agentId: string): AgentSessionState | undefined {
    return this.sessions.get(agentId)?.getState();
  }

  /**
   * Send input to a running agent. Throws `SessionResumeNotSupportedError`
   * if the underlying adapter doesn't support session-resume (ADR D5).
   */
  sendInput(_agentId: string, _text: string): void {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }

  /** Kill one session. Returns true if the session existed. */
  kill(_agentId: string): boolean {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }

  /** Kill every running session. Returns the number killed. */
  killAll(): number {
    throw new Error(PHASE_1_UNIMPLEMENTED);
  }
}
