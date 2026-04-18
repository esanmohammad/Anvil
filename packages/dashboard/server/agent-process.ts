/**
 * AgentProcess — multi-provider agent execution via adapter pattern.
 *
 * Delegates to the correct adapter (Claude CLI, Gemini CLI, or API)
 * based on the model ID. All adapters emit the same events, so
 * AgentManager and the dashboard don't need to know which provider is running.
 */

import { EventEmitter } from 'node:events';
import { createAdapter } from './adapters/adapter-factory.js';
import type { BaseAdapter } from './adapters/base-adapter.js';

// ── Types (public contract — unchanged) ───────────────────────────────

export interface AgentProcessConfig {
  prompt: string;
  model: string;
  sessionId: string;
  cwd: string;
  resume?: boolean;
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
}

export interface CostInfo {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
}

export interface AgentActivity {
  id: string;
  kind: 'tool_use' | 'thinking' | 'text';
  tool?: string;
  summary: string;
  content?: string;
  timestamp: number;
}

export interface AgentProcessEvents {
  content: (text: string) => void;
  activity: (activity: AgentActivity) => void;
  result: (data: { result: string; cost: CostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

// ── AgentProcess ──────────────────────────────────────────────────────

export class AgentProcess extends EventEmitter {
  private adapter: BaseAdapter | null = null;
  private config: AgentProcessConfig;

  constructor(config: AgentProcessConfig) {
    super();
    this.config = config;
  }

  // ── Typed event helpers ──────────────────────────────────────────────

  override on<K extends keyof AgentProcessEvents>(
    event: K,
    listener: AgentProcessEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AgentProcessEvents>(
    event: K,
    ...args: Parameters<AgentProcessEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  start(): void {
    this.adapter = createAdapter(this.config);

    // Pipe all adapter events through to AgentProcess
    this.adapter.on('content', (text) => this.emit('content', text));
    this.adapter.on('activity', (activity) => this.emit('activity', activity));
    this.adapter.on('result', (data) => this.emit('result', data));
    this.adapter.on('error-output', (text) => this.emit('error-output', text));
    this.adapter.on('exit', (code) => this.emit('exit', code));

    this.adapter.start();
  }

  kill(signal?: string): void {
    this.adapter?.kill();
  }

  get pid(): number | undefined {
    return this.adapter?.pid;
  }

  get killed(): boolean {
    return this.adapter?.killed ?? false;
  }
}
