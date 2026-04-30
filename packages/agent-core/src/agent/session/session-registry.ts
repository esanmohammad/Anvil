/**
 * `AgentSessionRegistry` — tracks many concurrent `AgentSession`s.
 *
 * Lifted from dashboard's `AgentManager` class
 * (`dashboard/server/agent-manager.ts`). Behavior parity:
 *
 *   - `spawn(spec)` consults the checkpoint hook; on hit, synthesizes a
 *     done-event without launching an adapter.
 *   - On miss, constructs an `AgentSession` (which spawns the adapter via
 *     the registry's `adapterFactory`) and re-emits the session's events
 *     onto the registry's own EventEmitter surface.
 *   - `sendInput(id, text)` delegates to the session.
 *   - `kill(id)` / `killAll()` propagate to sessions and update state.
 *   - The cost hook is invoked once per `result` event, and the checkpoint
 *     `record` (when present) is called with the same data.
 */

import { EventEmitter } from 'node:events';
import {
  AgentSession,
  appendOutput,
  type AgentSessionConstructorOpts,
} from './session.js';
import type { AgentAdapterFactory } from './adapter.js';
import type {
  AgentCheckpointHook,
  AgentCostHook,
  AgentSessionRegistryEvents,
  AgentSessionState,
  CostInfo,
  SessionSpec,
} from './types.js';
import { AgentSessionNotFoundError } from './types.js';

export interface AgentSessionRegistryOpts {
  /** Adapter factory — required. Same factory is reused for every spawn. */
  adapterFactory: AgentAdapterFactory;
  /** Test seam — clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — `setTimeout` substitute used by sessions. */
  setTimeoutImpl?: (fn: () => void, ms: number) => void;
  /**
   * Test seam — defer the cache-hit `agent-done` emission. Production uses
   * `process.nextTick` so listeners attached AFTER `spawn()` returns still
   * see the event.
   */
  nextTickImpl?: (fn: () => void) => void;
}

export class AgentSessionRegistry extends EventEmitter {
  protected readonly sessions = new Map<string, { session: AgentSession; spec: SessionSpec }>();
  protected costHook: AgentCostHook | null = null;
  protected checkpointHook: AgentCheckpointHook | null = null;
  protected readonly adapterFactory: AgentAdapterFactory;
  protected readonly now: () => number;
  protected readonly setTimeoutImpl: (fn: () => void, ms: number) => void;
  protected readonly nextTickImpl: (fn: () => void) => void;

  constructor(opts: AgentSessionRegistryOpts) {
    super();
    this.adapterFactory = opts.adapterFactory;
    this.now = opts.now ?? Date.now;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.nextTickImpl = opts.nextTickImpl ?? ((fn) => { process.nextTick(fn); });
  }

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

  setCostHook(hook: AgentCostHook | null): void { this.costHook = hook; }
  setCheckpointHook(hook: AgentCheckpointHook | null): void { this.checkpointHook = hook; }

  // ── Spawn ────────────────────────────────────────────────────────────

  /**
   * Spawn a new session. Returns a synchronous snapshot of its state.
   * On a checkpoint cache hit the snapshot has `status === 'done'` and the
   * `agent-done` event fires asynchronously (next tick) so listeners
   * attached after `spawn()` returns still observe it.
   */
  spawn(spec: SessionSpec): AgentSessionState {
    const sessionOpts: AgentSessionConstructorOpts = {
      adapterFactory: this.adapterFactory,
      now: this.now,
      setTimeoutImpl: this.setTimeoutImpl,
    };
    const session = new AgentSession(spec, sessionOpts);
    const agentId = session.id;

    // ── Checkpoint cache lookup ───────────────────────────────────────
    if (this.checkpointHook) {
      try {
        const hit = this.checkpointHook.lookup({
          project: spec.project,
          stage: spec.stage,
          persona: spec.persona,
          model: spec.model,
          prompt: spec.prompt,
          runFamily: spec.runFamily ?? spec.runId,
        });
        if (hit.hit) {
          // Manually populate state — no adapter ever spawns.
          const state = session.getState();
          state.status = 'done';
          state.startedAt = this.now();
          state.finishedAt = this.now();
          appendOutput(state, hit.output);
          if (hit.cost) state.cost = hit.cost;
          this.sessions.set(agentId, { session, spec });
          this.nextTickImpl(() => {
            this.emit('agent-done', { agent: state });
          });
          return state;
        }
      } catch (err) {
        process.stderr.write(
          `[agent-session-registry] checkpoint lookup failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // ── Wire session events through to the registry surface ──────────
    this.wireSession(agentId, session, spec);

    session.start();
    this.sessions.set(agentId, { session, spec });
    return session.getState();
  }

  // ── Send input ───────────────────────────────────────────────────────

  /** Send input to a running agent. Throws if the agent is not registered. */
  sendInput(agentId: string, text: string): void {
    const entry = this.sessions.get(agentId);
    if (!entry) throw new AgentSessionNotFoundError(agentId);
    // Show user message in registry output stream BEFORE the session emits
    // its own copy — preserves dashboard's emit order
    // (`agent-output` first, then session's own `content`).
    this.emit('agent-output', { agentId, chunk: `\n\n> User: ${text}\n\n` });
    entry.session.sendInput(text);
  }

  // ── Kill ─────────────────────────────────────────────────────────────

  kill(agentId: string): boolean {
    const entry = this.sessions.get(agentId);
    if (!entry) return false;
    entry.session.kill();
    return true;
  }

  killAll(): number {
    let killed = 0;
    for (const { session } of this.sessions.values()) {
      const status = session.getState().status;
      if (status === 'running' || status === 'pending') {
        try {
          session.kill('SIGTERM');
          killed++;
        } catch { /* already dead */ }
      }
    }
    return killed;
  }

  // ── Queries ──────────────────────────────────────────────────────────

  getAgent(agentId: string): AgentSessionState | undefined {
    return this.sessions.get(agentId)?.session.getState();
  }

  getAllAgents(): AgentSessionState[] {
    return Array.from(this.sessions.values()).map((e) => e.session.getState());
  }

  // ── Internals ────────────────────────────────────────────────────────

  protected wireSession(agentId: string, session: AgentSession, spec: SessionSpec): void {
    session.on('content', (chunk: string) => {
      this.emit('agent-output', { agentId, chunk });
    });
    session.on('activity', (activity) => {
      this.emit('agent-activity', { agentId, activity });
    });
    session.on('result', (data: { result: string; cost: CostInfo; sessionId: string }) => {
      const state = session.getState();
      this.fireCostHook(agentId, spec, data.cost);
      this.fireCheckpointRecord(spec, data.result || state.output, state.cost);
      this.emit('agent-done', { agent: state });
    });
    session.on('error-output', (text: string) => {
      this.emit('agent-error', { agentId, error: text });
    });
    session.on('exit', () => {
      const state = session.getState();
      if (state.status === 'error' && state.error) {
        this.emit('agent-error', { agentId, error: state.error });
      } else if (state.status === 'done' && state.finishedAt !== state.startedAt) {
        // The 0-exit grace-window path resolves through here. Adapters that
        // emitted a `result` already triggered `agent-done`; this branch
        // covers the case where exit fired without a result event.
        this.emit('agent-done', { agent: state });
      }
    });
  }

  protected fireCostHook(agentId: string, spec: SessionSpec, cost: CostInfo): void {
    if (!this.costHook) return;
    try {
      void this.costHook({
        runId: spec.runId,
        project: spec.project,
        stage: spec.stage,
        agent: agentId,
        persona: spec.persona,
        model: spec.model,
        tokensIn: cost.inputTokens,
        tokensOut: cost.outputTokens,
        cacheReadTokens: cost.cacheReadTokens,
        cacheWriteTokens: cost.cacheWriteTokens,
        usd: cost.totalUsd,
      });
    } catch (err) {
      process.stderr.write(
        `[agent-session-registry] cost hook threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  protected fireCheckpointRecord(spec: SessionSpec, output: string, cost: CostInfo): void {
    if (!this.checkpointHook?.record) return;
    try {
      this.checkpointHook.record({
        project: spec.project,
        stage: spec.stage,
        persona: spec.persona,
        model: spec.model,
        prompt: spec.prompt,
        runFamily: spec.runFamily ?? spec.runId,
        output,
        cost,
      });
    } catch (err) {
      process.stderr.write(
        `[agent-session-registry] checkpoint record threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
