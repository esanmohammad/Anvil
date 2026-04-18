/** WebSocket server types for Anvil dashboard */

export type Channel = 'pipeline' | 'activity' | 'output' | 'project';

export interface WSMessage<T = unknown> {
  channel: Channel;
  event: string;
  data: T;
  timestamp: number;
  id?: string;
}

export interface PipelineStage {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  progress: number; // 0-100
  startedAt?: number;
  completedAt?: number;
  repo?: string;
}

export interface PipelineUpdate {
  runId: string;
  project: string;
  stages: PipelineStage[];
  currentStage: number;
  overallProgress: number;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
}

export interface ActivityEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
  repo?: string;
  stage?: string;
  metadata?: Record<string, unknown>;
}

export interface OutputChunk {
  runId: string;
  repo: string;
  stage: string;
  type: 'stdout' | 'stderr' | 'tool_call' | 'tool_result';
  content: string;
  timestamp: number;
  toolName?: string;
}

export interface ProjectStatus {
  project: string;
  status: 'online' | 'offline' | 'degraded';
  repos: Array<{
    name: string;
    status: 'ready' | 'busy' | 'error';
    currentStage?: string;
  }>;
  uptime: number;
  lastActivity: number;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
  serverUptime: number;
}

export interface ClientSubscription {
  channel: Channel;
  filters?: Record<string, string>;
}

export interface WSClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'pong' | 'action';
  channel?: Channel;
  filters?: Record<string, string>;
  action?: string;
  payload?: unknown;
}
