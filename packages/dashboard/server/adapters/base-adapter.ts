/**
 * Base adapter interface for all AI provider adapters.
 *
 * Every adapter emits the same events so AgentProcess can delegate
 * transparently regardless of provider.
 */

import { EventEmitter } from 'node:events';

export interface AdapterConfig {
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

export interface AdapterCostInfo {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
}

export interface AdapterActivity {
  id: string;
  kind: 'tool_use' | 'thinking' | 'text';
  tool?: string;
  summary: string;
  content?: string;
  timestamp: number;
}

export interface AdapterEvents {
  content: (text: string) => void;
  activity: (activity: AdapterActivity) => void;
  result: (data: { result: string; cost: AdapterCostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

export abstract class BaseAdapter extends EventEmitter {
  protected config: AdapterConfig;
  protected activityCounter = 0;

  constructor(config: AdapterConfig) {
    super();
    this.config = config;
  }

  abstract start(): void;
  abstract kill(): void;
  abstract get pid(): number | undefined;
  abstract get killed(): boolean;

  protected nextActivityId(): string {
    return `act-${this.config.sessionId.slice(0, 8)}-${++this.activityCounter}`;
  }

  protected zeroCost(): AdapterCostInfo {
    return {
      totalUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
    };
  }

  // Typed emit helpers
  override emit<K extends keyof AdapterEvents>(
    event: K,
    ...args: Parameters<AdapterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AdapterEvents>(
    event: K,
    listener: AdapterEvents[K],
  ): this {
    return super.on(event, listener);
  }
}
