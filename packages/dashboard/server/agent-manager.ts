/**
 * AgentManager — tracks spawned Claude agents and their state.
 *
 * Adapted from Hivemind's agent-manager.ts for the Anvil dashboard.
 * Manages agent lifecycle: spawn, sendInput (via --resume), kill, and state queries.
 * Emits events that the WebSocket server can broadcast to connected clients.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { AgentProcess, CostInfo, AgentActivity } from './agent-process.js';
import type { AgentProcessConfig } from './agent-process.js';

// Re-export the checkpoint-gating wrapper so callers using AgentManager have a
// matching helper for one-shot agent calls outside the manager (e.g. small
// deterministic stages that still want crash-safe caching). The wrapper lives
// in its own module to keep AgentManager free of CheckpointStore deps.
export { runWithCheckpoint } from './agent-runner-wrapper.js';
export type { WrappedAgentOpts } from './agent-runner-wrapper.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface AgentState {
  id: string;
  name: string;
  persona: string;
  sessionId: string;
  model: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'killed';
  cost: CostInfo;
  output: string;
  activities: AgentActivity[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

export interface SpawnConfig {
  name: string;
  persona: string;
  project: string;
  stage: string;
  prompt: string;
  model: string;
  cwd: string;
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  /** Pipeline runId, used by cost/checkpoint hooks to group entries. */
  runId?: string;
  /** Stable cross-retry id for the checkpoint cache. Defaults to runId. */
  runFamily?: string;
  /**
   * Phase 3 — output-token ceiling for this stage's call. Forwarded to the
   * adapter via setMaxOutputTokens(). Caller (pipeline-runner) is the
   * source of truth via STAGE_OUTPUT_LIMITS.
   */
  maxOutputTokens?: number;
}

export interface AgentManagerEvents {
  'agent-output': (data: { agentId: string; chunk: string }) => void;
  'agent-activity': (data: { agentId: string; activity: AgentActivity }) => void;
  'agent-done': (data: { agent: AgentState }) => void;
  'agent-error': (data: { agentId: string; error: string }) => void;
}

/**
 * Cost hook — invoked after every agent result so a ledger can record
 * token usage and trigger breach flows. Fire-and-forget; hook impls must
 * never throw back into the manager.
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
    /** Phase 1: cache-read tokens reported by the provider (0 when unknown). */
    cacheReadTokens: number;
    /** Phase 1: cache-write/creation tokens reported by the provider. */
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

// ── Helpers ──────────────────────────────────────────────────────────────

function emptyCost(): CostInfo {
  return {
    totalUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
  };
}

function generateSessionId(_project: string, _stage: string): string {
  // Claude CLI requires a valid UUID v4 for --session-id
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Cap in-memory output to 500KB, keeping the tail */
const MAX_OUTPUT_BYTES = 500 * 1024;

function appendOutput(agent: AgentState, chunk: string): void {
  agent.output += chunk;
  if (agent.output.length > MAX_OUTPUT_BYTES) {
    agent.output = agent.output.slice(-MAX_OUTPUT_BYTES);
  }
}

/** Cap in-memory activities to 500 entries */
const MAX_ACTIVITIES = 500;

function pushActivity(agent: AgentState, activity: AgentActivity): void {
  agent.activities.push(activity);
  if (agent.activities.length > MAX_ACTIVITIES) {
    agent.activities = agent.activities.slice(-MAX_ACTIVITIES);
  }
}

// ── AgentManager ─────────────────────────────────────────────────────────

export class AgentManager extends EventEmitter {
  private agents = new Map<string, { state: AgentState; process: AgentProcess; spawnConfig?: SpawnConfig }>();
  private costHook: AgentCostHook | null = null;
  private checkpointHook: AgentCheckpointHook | null = null;

  setCostHook(hook: AgentCostHook | null): void { this.costHook = hook; }
  setCheckpointHook(hook: AgentCheckpointHook | null): void { this.checkpointHook = hook; }

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

  // ── Spawn ────────────────────────────────────────────────────────────

  spawn(config: SpawnConfig): AgentState {
    const sessionId = generateSessionId(config.project, config.stage);
    const agentId = sessionId; // use session ID as agent ID for simplicity

    const agent: AgentState = {
      id: agentId,
      name: config.name,
      persona: config.persona,
      sessionId,
      model: config.model,
      status: 'pending',
      cost: emptyCost(),
      output: '',
      activities: [],
      startedAt: null,
      finishedAt: null,
      error: null,
    };

    // ── Checkpoint cache lookup ───────────────────────────────────────
    // If a cached run exists for this (project,stage,persona,model,prompt),
    // skip the subprocess and synthesize a done-event.
    if (this.checkpointHook) {
      try {
        const hit = this.checkpointHook.lookup({
          project: config.project, stage: config.stage, persona: config.persona,
          model: config.model, prompt: config.prompt, runFamily: config.runFamily ?? config.runId,
        });
        if (hit.hit) {
          agent.status = 'done';
          agent.startedAt = Date.now();
          agent.finishedAt = Date.now();
          appendOutput(agent, hit.output);
          if (hit.cost) agent.cost = hit.cost;
          this.agents.set(agentId, { state: agent, process: null as unknown as AgentProcess, spawnConfig: config });
          // Emit after the caller receives the AgentState so listeners see 'done'.
          process.nextTick(() => this.emit('agent-done', { agent }));
          return agent;
        }
      } catch (err) {
        console.warn('[agent-manager] checkpoint lookup failed:', err);
      }
    }

    const proc = new AgentProcess({
      prompt: config.prompt,
      model: config.model,
      sessionId,
      cwd: config.cwd,
      projectPrompt: config.projectPrompt,
      permissionMode: config.permissionMode,
      disallowedTools: config.disallowedTools,
      allowedTools: config.allowedTools,
      maxOutputTokens: config.maxOutputTokens,
    });

    this.wireEvents(agentId, agent, proc);

    // Start the process
    proc.start();
    agent.status = 'running';
    agent.startedAt = Date.now();

    this.agents.set(agentId, { state: agent, process: proc, spawnConfig: config });
    return agent;
  }

  // ── Send input (resume) ──────────────────────────────────────────────

  sendInput(agentId: string, text: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) throw new Error(`Agent ${agentId} not found`);

    const { state: agent } = entry;

    // Show user message in output stream
    const userChunk = `\n\n> User: ${text}\n\n`;
    appendOutput(agent, userChunk);
    this.emit('agent-output', { agentId, chunk: userChunk });

    // Update agent status back to running
    agent.status = 'running';
    agent.finishedAt = null;

    // Spawn a NEW process that resumes the session
    const resumeProcess = new AgentProcess({
      prompt: text,
      model: agent.model, // pass model so adapter factory routes correctly
      sessionId: agent.sessionId,
      cwd: process.cwd(),
      resume: true,
      maxOutputTokens: entry.spawnConfig?.maxOutputTokens,
    });

    this.wireEvents(agentId, agent, resumeProcess);

    // Replace the old process reference
    entry.process = resumeProcess;
    resumeProcess.start();
  }

  // ── Kill ─────────────────────────────────────────────────────────────

  kill(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;

    entry.process.kill();
    entry.state.status = 'killed';
    entry.state.finishedAt = Date.now();
    return true;
  }

  /**
   * Kill all running agents. Called during graceful shutdown.
   */
  killAll(): number {
    let killed = 0;
    for (const [id, entry] of this.agents) {
      if (entry.state.status === 'running' || entry.state.status === 'pending') {
        try {
          entry.process.kill('SIGTERM');
          entry.state.status = 'killed';
          entry.state.finishedAt = Date.now();
          killed++;
        } catch { /* already dead */ }
      }
    }
    return killed;
  }

  // ── Queries ──────────────────────────────────────────────────────────

  getAgent(agentId: string): AgentState | undefined {
    return this.agents.get(agentId)?.state;
  }

  getAllAgents(): AgentState[] {
    return Array.from(this.agents.values()).map((e) => e.state);
  }

  // ── Event wiring ─────────────────────────────────────────────────────

  private wireEvents(agentId: string, agent: AgentState, proc: AgentProcess): void {
    proc.on('content', (chunk) => {
      appendOutput(agent, chunk);
      this.emit('agent-output', { agentId, chunk });
    });

    proc.on('activity', (activity) => {
      pushActivity(agent, activity);
      this.emit('agent-activity', { agentId, activity });
    });

    proc.on('result', ({ result, cost, sessionId: sid }) => {
      agent.status = 'done';
      agent.finishedAt = Date.now();
      agent.sessionId = sid;

      // Accumulate cost across resume calls. stopReason is the LAST signal
      // from the provider (a multi-turn resume can re-emit), so prefer the
      // freshly reported value and fall back to whatever we had before.
      agent.cost = {
        totalUsd: agent.cost.totalUsd + cost.totalUsd,
        inputTokens: agent.cost.inputTokens + cost.inputTokens,
        outputTokens: agent.cost.outputTokens + cost.outputTokens,
        cacheReadTokens: agent.cost.cacheReadTokens + cost.cacheReadTokens,
        cacheWriteTokens: agent.cost.cacheWriteTokens + cost.cacheWriteTokens,
        durationMs: agent.cost.durationMs + cost.durationMs,
        stopReason: cost.stopReason ?? agent.cost.stopReason,
      };

      if (result) {
        appendOutput(agent, result);
      }

      // ── Cost ledger hook ─────────────────────────────────────────
      if (this.costHook) {
        const entry = this.agents.get(agentId);
        const cfg = entry?.spawnConfig;
        try {
          void this.costHook({
            runId: cfg?.runId,
            project: cfg?.project,
            stage: cfg?.stage,
            agent: agentId,
            persona: agent.persona,
            model: agent.model,
            tokensIn: cost.inputTokens,
            tokensOut: cost.outputTokens,
            cacheReadTokens: cost.cacheReadTokens,
            cacheWriteTokens: cost.cacheWriteTokens,
            usd: cost.totalUsd,
          });
        } catch (err) {
          console.warn('[agent-manager] cost hook threw:', err);
        }
      }

      // ── Checkpoint record ────────────────────────────────────────
      if (this.checkpointHook?.record) {
        const entry = this.agents.get(agentId);
        const cfg = entry?.spawnConfig;
        if (cfg) {
          try {
            this.checkpointHook.record({
              project: cfg.project, stage: cfg.stage, persona: cfg.persona,
              model: cfg.model, prompt: cfg.prompt,
              runFamily: cfg.runFamily ?? cfg.runId,
              output: result ?? agent.output,
              cost: agent.cost,
            });
          } catch (err) {
            console.warn('[agent-manager] checkpoint record threw:', err);
          }
        }
      }

      this.emit('agent-done', { agent });
    });

    proc.on('error-output', (text) => {
      if (!agent.error) agent.error = '';
      agent.error += text;
      this.emit('agent-error', { agentId, error: text });
    });

    proc.on('exit', (code) => {
      if (agent.status === 'done' || agent.status === 'killed') return;
      if (code !== 0) {
        agent.status = 'error';
        agent.finishedAt = Date.now();
        if (!agent.error) {
          agent.error = `Process exited with code ${code}`;
        }
        this.emit('agent-error', { agentId, error: agent.error! });
      } else {
        // Clean exit but no result event — wait a moment for late events
        setTimeout(() => {
          if (agent.status !== 'running') return;
          // If the agent ran < 5s with no output and no cost, treat as error
          const elapsed = Date.now() - (agent.startedAt ?? Date.now());
          if (elapsed < 5000 && !agent.output.trim() && agent.cost.totalUsd === 0) {
            agent.status = 'error';
            agent.finishedAt = Date.now();
            agent.error = agent.error || 'Agent exited immediately with no output. Check workspace directory and Claude CLI configuration.';
            this.emit('agent-error', { agentId, error: agent.error });
          } else {
            agent.status = 'done';
            agent.finishedAt = Date.now();
            this.emit('agent-done', { agent });
          }
        }, 500);
      }
    });
  }
}
