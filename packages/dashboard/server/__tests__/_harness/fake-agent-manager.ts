/**
 * Deterministic FakeAgentManager for scenario tests.
 *
 * Extends the real `AgentManager` so the dashboard's `agentManager.on(...)`
 * subscriptions, `agentManager.spawn = wrapper` monkey-patches, and
 * `agentManager.kill / killAll / sendInput / setCostHook / setCheckpointHook`
 * call-sites all work without modification. We only override the heavyweight
 * paths (spawn, kill) so no real adapter is ever resolved.
 *
 * Test API (call from scenario tests):
 *   manager.emitActivity(agentId, activity)
 *   manager.emitOutput(agentId, chunk)
 *   manager.emitDone(agentId, status, meta?)
 *   manager.emitError(agentId, err)
 *
 * These map 1:1 onto the four `AgentManagerEvents` so subscribers in
 * dashboard-server.ts see exactly what they'd see from a real agent.
 */

import {
  AgentManager,
  type AgentState,
  type SpawnConfig,
} from '@esankhan3/anvil-agent-core';

interface AgentRecord {
  state: AgentState;
  spec: SpawnConfig;
}

export class FakeAgentManager extends AgentManager {
  private counter = 0;
  private fakeAgents = new Map<string, AgentRecord>();
  private killCalls: string[] = [];
  private inputs: Array<{ agentId: string; text: string }> = [];

  constructor() {
    super({
      // Adapter factory should never be invoked — `spawn` is overridden.
      // If it ever IS called, the error surfaces loudly rather than silently
      // hitting a real provider.
      adapterFactory: () => {
        throw new Error('FakeAgentManager.adapterFactory called — should not happen');
      },
    });
  }

  override spawn(spec: SpawnConfig): AgentState {
    const id = `agent-fake-${(++this.counter).toString(16).padStart(8, '0')}`;
    const state: AgentState = {
      id,
      name: spec.name,
      persona: spec.persona,
      sessionId: `fake-session-${id}`,
      model: spec.model,
      status: 'running',
      cost: {
        totalUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
      },
      output: '',
      activities: [],
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this.fakeAgents.set(id, { state, spec });
    return state;
  }

  override kill(agentId: string): boolean {
    const rec = this.fakeAgents.get(agentId);
    if (!rec) return false;
    this.killCalls.push(agentId);
    rec.state.status = 'killed';
    rec.state.finishedAt = Date.now();
    rec.state.error = 'killed';
    this.emit('agent-error', { agentId, error: 'killed' });
    this.emit('agent-done', { agent: rec.state });
    return true;
  }

  override killAll(): number {
    const ids = [...this.fakeAgents.keys()].filter(
      (id) => this.fakeAgents.get(id)!.state.status === 'running',
    );
    for (const id of ids) this.kill(id);
    return ids.length;
  }

  override sendInput(agentId: string, text: string): void {
    if (!this.fakeAgents.has(agentId)) return;
    this.inputs.push({ agentId, text });
  }

  // ── Test API: drive the scripted lifecycle ──────────────────────────

  emitActivity(agentId: string, activity: {
    kind: 'tool_use' | 'thinking' | 'text' | 'tool_result';
    summary: string;
    tool?: string;
    content?: string;
  }): void {
    const rec = this.fakeAgents.get(agentId);
    if (!rec) throw new Error(`FakeAgentManager: no agent ${agentId}`);
    const full = {
      id: `act-${rec.state.activities.length + 1}`,
      timestamp: Date.now(),
      ...activity,
    };
    rec.state.activities.push(full);
    this.emit('agent-activity', { agentId, activity: full });
  }

  emitOutput(agentId: string, chunk: string): void {
    const rec = this.fakeAgents.get(agentId);
    if (!rec) throw new Error(`FakeAgentManager: no agent ${agentId}`);
    rec.state.output += chunk;
    this.emit('agent-output', { agentId, chunk });
  }

  emitDone(
    agentId: string,
    status: 'done' | 'error' = 'done',
    meta?: { finalAnswer?: string; error?: string },
  ): void {
    const rec = this.fakeAgents.get(agentId);
    if (!rec) throw new Error(`FakeAgentManager: no agent ${agentId}`);
    rec.state.status = status;
    rec.state.finishedAt = Date.now();
    if (meta?.finalAnswer !== undefined) rec.state.finalAnswer = meta.finalAnswer;
    if (meta?.error) rec.state.error = meta.error;
    this.emit('agent-done', { agent: rec.state });
  }

  emitError(agentId: string, error: string): void {
    const rec = this.fakeAgents.get(agentId);
    if (!rec) throw new Error(`FakeAgentManager: no agent ${agentId}`);
    this.emit('agent-error', { agentId, error });
  }

  // ── Test inspection ─────────────────────────────────────────────────

  /** Snapshot of every spawn call that landed on this manager. */
  spawnedAgents(): Array<{ id: string; spec: SpawnConfig }> {
    return [...this.fakeAgents.entries()].map(([id, rec]) => ({ id, spec: rec.spec }));
  }

  /** Returns true if `kill(agentId)` was called at any point. */
  wasKilled(agentId: string): boolean {
    return this.killCalls.includes(agentId);
  }

  /** Records every `sendInput` call so scenarios can assert on input flow. */
  receivedInputs(): Array<{ agentId: string; text: string }> {
    return [...this.inputs];
  }
}
