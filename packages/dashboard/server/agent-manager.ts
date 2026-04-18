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
}

export interface AgentManagerEvents {
  'agent-output': (data: { agentId: string; chunk: string }) => void;
  'agent-activity': (data: { agentId: string; activity: AgentActivity }) => void;
  'agent-done': (data: { agent: AgentState }) => void;
  'agent-error': (data: { agentId: string; error: string }) => void;
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
  private agents = new Map<string, { state: AgentState; process: AgentProcess }>();

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

    const proc = new AgentProcess({
      prompt: config.prompt,
      model: config.model,
      sessionId,
      cwd: config.cwd,
      projectPrompt: config.projectPrompt,
      permissionMode: config.permissionMode,
      disallowedTools: config.disallowedTools,
      allowedTools: config.allowedTools,
    });

    this.wireEvents(agentId, agent, proc);

    // Start the process
    proc.start();
    agent.status = 'running';
    agent.startedAt = Date.now();

    this.agents.set(agentId, { state: agent, process: proc });
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

      // Accumulate cost across resume calls
      agent.cost = {
        totalUsd: agent.cost.totalUsd + cost.totalUsd,
        inputTokens: agent.cost.inputTokens + cost.inputTokens,
        outputTokens: agent.cost.outputTokens + cost.outputTokens,
        cacheReadTokens: agent.cost.cacheReadTokens + cost.cacheReadTokens,
        cacheWriteTokens: agent.cost.cacheWriteTokens + cost.cacheWriteTokens,
        durationMs: agent.cost.durationMs + cost.durationMs,
      };

      if (result) {
        appendOutput(agent, result);
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
