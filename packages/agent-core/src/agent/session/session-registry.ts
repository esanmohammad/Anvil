/**
 * `AgentManager` — tracks many concurrent `AgentProcess`es.
 *
 * Behavior:
 *   - `spawn(config)` consults the checkpoint hook; on hit, synthesizes a
 *     done-event without launching an adapter.
 *   - On miss, constructs an `AgentProcess` (which spawns the adapter via
 *     the manager's `adapterFactory`) and re-emits the process's events
 *     onto the manager's own EventEmitter surface.
 *   - `sendInput(id, text)` delegates to the process.
 *   - `kill(id)` / `killAll()` propagate to processes and update state.
 *   - The cost hook is invoked once per `result` event, and the checkpoint
 *     `record` (when present) is called with the same data.
 */

import { EventEmitter } from 'node:events';
import {
  AgentProcess,
  appendOutput,
  type AgentProcessOpts,
} from './session.js';
import type { AgentAdapterFactory } from './adapter.js';
import type {
  AgentCheckpointHook,
  AgentCostHook,
  AgentManagerEvents,
  AgentState,
  CostInfo,
  SpawnConfig,
} from './types.js';
import { AgentNotFoundError } from './types.js';

export interface AgentManagerOpts {
  /** Adapter factory — required. Same factory is reused for every spawn. */
  adapterFactory: AgentAdapterFactory;
  /** Test seam — clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — `setTimeout` substitute used by processes. */
  setTimeoutImpl?: (fn: () => void, ms: number) => void;
  /**
   * Test seam — defer the cache-hit `agent-done` emission. Production uses
   * `process.nextTick` so listeners attached AFTER `spawn()` returns still
   * see the event.
   */
  nextTickImpl?: (fn: () => void) => void;
}

export class AgentManager extends EventEmitter {
  protected readonly processes = new Map<string, { process: AgentProcess; spec: SpawnConfig }>();
  protected costHook: AgentCostHook | null = null;
  protected checkpointHook: AgentCheckpointHook | null = null;
  protected readonly adapterFactory: AgentAdapterFactory;
  protected readonly now: () => number;
  protected readonly setTimeoutImpl: (fn: () => void, ms: number) => void;
  protected readonly nextTickImpl: (fn: () => void) => void;

  constructor(opts: AgentManagerOpts) {
    super();
    this.adapterFactory = opts.adapterFactory;
    this.now = opts.now ?? Date.now;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.nextTickImpl = opts.nextTickImpl ?? ((fn) => { process.nextTick(fn); });
  }

  // ── Typed event helpers ──────────────────────────────────────────────

  override on<K extends keyof AgentManagerEvents>(
    event: K,
    listener: AgentManagerEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AgentManagerEvents>(
    event: K,
    ...args: Parameters<AgentManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ── Hooks ────────────────────────────────────────────────────────────

  setCostHook(hook: AgentCostHook | null): void { this.costHook = hook; }
  setCheckpointHook(hook: AgentCheckpointHook | null): void { this.checkpointHook = hook; }

  // ── Spawn ────────────────────────────────────────────────────────────

  /**
   * Spawn a new agent. Returns a synchronous snapshot of its state. On a
   * checkpoint cache hit the snapshot has `status === 'done'` and the
   * `agent-done` event fires asynchronously (next tick) so listeners
   * attached after `spawn()` returns still observe it.
   */
  spawn(spec: SpawnConfig): AgentState {
    const processOpts: AgentProcessOpts = {
      adapterFactory: this.adapterFactory,
      now: this.now,
      setTimeoutImpl: this.setTimeoutImpl,
    };
    const proc = new AgentProcess(spec, processOpts);
    const agentId = proc.id;

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
          const state = proc.getState();
          state.status = 'done';
          state.startedAt = this.now();
          state.finishedAt = this.now();
          appendOutput(state, hit.output);
          if (hit.cost) state.cost = hit.cost;
          this.processes.set(agentId, { process: proc, spec });
          this.nextTickImpl(() => {
            this.emit('agent-done', { agent: state });
          });
          return state;
        }
      } catch (err) {
        process.stderr.write(
          `[agent-manager] checkpoint lookup failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // ── Wire process events through to the manager surface ──────────
    this.wireProcess(agentId, proc, spec);

    proc.start();
    this.processes.set(agentId, { process: proc, spec });
    return proc.getState();
  }

  // ── Send input ───────────────────────────────────────────────────────

  /** Send input to a running agent. Throws if the agent is not registered. */
  sendInput(agentId: string, text: string): void {
    const entry = this.processes.get(agentId);
    if (!entry) throw new AgentNotFoundError(agentId);
    // Show user message in manager output stream BEFORE the process emits
    // its own copy — preserves the dashboard emit order
    // (`agent-output` first, then process's own `content`).
    this.emit('agent-output', { agentId, chunk: `\n\n> User: ${text}\n\n` });
    entry.process.sendInput(text);
  }

  // ── Kill ─────────────────────────────────────────────────────────────

  kill(agentId: string): boolean {
    const entry = this.processes.get(agentId);
    if (!entry) return false;
    entry.process.kill();
    return true;
  }

  killAll(): number {
    let killed = 0;
    for (const { process: proc } of this.processes.values()) {
      const status = proc.getState().status;
      if (status === 'running' || status === 'pending') {
        try {
          proc.kill('SIGTERM');
          killed++;
        } catch { /* already dead */ }
      }
    }
    return killed;
  }

  // ── Queries ──────────────────────────────────────────────────────────

  getAgent(agentId: string): AgentState | undefined {
    return this.processes.get(agentId)?.process.getState();
  }

  getAllAgents(): AgentState[] {
    return Array.from(this.processes.values()).map((e) => e.process.getState());
  }

  // ── Internals ────────────────────────────────────────────────────────

  protected wireProcess(agentId: string, proc: AgentProcess, spec: SpawnConfig): void {
    proc.on('content', (chunk: string) => {
      this.emit('agent-output', { agentId, chunk });
    });
    proc.on('activity', (activity) => {
      this.emit('agent-activity', { agentId, activity });
    });
    proc.on('result', (data: { result: string; cost: CostInfo; sessionId: string }) => {
      const state = proc.getState();
      this.fireCostHook(agentId, spec, data.cost);
      this.fireCheckpointRecord(spec, data.result || state.output, state.cost);
      this.emit('agent-done', { agent: state });
    });
    proc.on('error-output', (text: string) => {
      this.emit('agent-error', { agentId, error: text });
    });
    proc.on('exit', () => {
      const state = proc.getState();
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

  protected fireCostHook(agentId: string, spec: SpawnConfig, cost: CostInfo): void {
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
        `[agent-manager] cost hook threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  protected fireCheckpointRecord(spec: SpawnConfig, output: string, cost: CostInfo): void {
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
        `[agent-manager] checkpoint record threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
