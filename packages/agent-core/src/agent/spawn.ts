/**
 * Agent Process Manager — subprocess spawning.
 * Uses `--output-format stream-json` like Hivemind for real-time streaming.
 */

import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentProcessConfig, AgentProcessState, AgentEvent } from './types.js';

// ---------------------------------------------------------------------------
// AgentProcess interface
// ---------------------------------------------------------------------------

export interface AgentProcess {
  /** OS process id (undefined before spawn). */
  pid: number | undefined;
  /** Writable stream connected to stdin. */
  stdin: ChildProcess['stdin'];
  /** Event emitter that fires AgentEvent objects. */
  events: EventEmitter;
  /** Current lifecycle state. */
  state: AgentProcessState;
  /** Kill the underlying process. */
  kill: (signal?: NodeJS.Signals) => void;
  /** Underlying ChildProcess — exposed for advanced usage. */
  child: ChildProcess;
}

// ---------------------------------------------------------------------------
// Stream-JSON message types (from Claude CLI)
// ---------------------------------------------------------------------------
interface ClaudeStreamMessage {
  type: string;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  duration_ms?: number;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
    }>;
  };
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Reading ${input.file_path ?? 'file'}`;
    case 'Edit':
      return `Editing ${input.file_path ?? 'file'}`;
    case 'Write':
      return `Writing ${input.file_path ?? 'file'}`;
    case 'Bash':
      return `Running: ${String(input.command ?? input.description ?? '').slice(0, 120)}`;
    case 'Grep':
      return `Searching for "${String(input.pattern ?? '').slice(0, 60)}"`;
    case 'Glob':
      return `Finding files: ${input.pattern ?? ''}`;
    case 'Agent':
      return `Spawning agent: ${String(input.description ?? '').slice(0, 100)}`;
    default:
      return `${name}`;
  }
}

// ---------------------------------------------------------------------------
// spawnAgent — uses stream-json output format like Hivemind
// ---------------------------------------------------------------------------

export function spawnAgent(config: AgentProcessConfig): AgentProcess {
  const args: string[] = [
    ...config.args,
    '--output-format', 'stream-json',
    '--verbose',
    ...(config.projectPrompt
      ? ['--project-prompt', config.projectPrompt]
      : []),
  ];

  const child = cpSpawn(config.binaryPath, args, {
    cwd: config.workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Close stdin immediately — non-interactive mode
  child.stdin?.end();

  const events = new EventEmitter();
  let buffer = '';

  const agentProcess: AgentProcess = {
    pid: child.pid,
    stdin: child.stdin,
    events,
    state: 'running',
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      child.kill(signal);
    },
    child,
  };

  // Parse stream-json output line by line
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: ClaudeStreamMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Not JSON — emit as raw output
        events.emit('event', { type: 'output', data: trimmed } as AgentEvent);
        continue;
      }

      if (msg.type === 'result') {
        // Final result with cost info
        events.emit('event', {
          type: 'output',
          data: msg.result ?? '',
        } as AgentEvent);
        events.emit('event', {
          type: 'result',
          data: JSON.stringify({
            result: msg.result ?? '',
            cost: msg.total_cost_usd ?? 0,
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
            durationMs: msg.duration_ms ?? 0,
            sessionId: msg.session_id ?? '',
          }),
        } as AgentEvent);
      } else if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            // Text content — stream it
            events.emit('event', {
              type: 'output',
              data: block.text,
            } as AgentEvent);
            events.emit('event', {
              type: 'activity',
              data: JSON.stringify({
                kind: 'text',
                summary: block.text.slice(0, 200),
                content: block.text,
                timestamp: Date.now(),
              }),
            } as AgentEvent);
          } else if (block.type === 'tool_use' && block.name) {
            const input = block.input ?? {};
            events.emit('event', {
              type: 'activity',
              data: JSON.stringify({
                kind: 'tool_use',
                tool: block.name,
                summary: summarizeToolUse(block.name, input),
                content: JSON.stringify(input, null, 2),
                timestamp: Date.now(),
              }),
            } as AgentEvent);
          } else if (block.type === 'thinking' && block.text) {
            events.emit('event', {
              type: 'activity',
              data: JSON.stringify({
                kind: 'thinking',
                summary: block.text.slice(0, 200),
                content: block.text,
                timestamp: Date.now(),
              }),
            } as AgentEvent);
          }
        }
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const evt: AgentEvent = { type: 'error', data: chunk.toString() };
    events.emit('event', evt);
  });

  child.on('close', (code, signal) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      events.emit('event', { type: 'output', data: buffer } as AgentEvent);
      buffer = '';
    }
    agentProcess.state = code === 0 ? 'completed' : 'failed';
    const evt: AgentEvent = {
      type: 'exit',
      code: code ?? 1,
      ...(signal ? { signal } : {}),
    };
    events.emit('event', evt);
  });

  return agentProcess;
}
