/**
 * Claude CLI adapter — extracted from agent-process.ts.
 *
 * Spawns the Claude CLI binary with `--output-format stream-json`
 * and parses structured events. This is the original execution path.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { BaseAdapter, type AdapterConfig, type AdapterCostInfo } from './base-adapter.js';

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';

interface StreamContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  message?: { content?: StreamContentBlock[] };
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
}

export class ClaudeAdapter extends BaseAdapter {
  private proc: ChildProcess | null = null;
  private buffer = '';

  constructor(config: AdapterConfig) {
    super(config);
  }

  start(): void {
    const args = this.buildArgs();

    this.proc = spawn(CLAUDE_BIN, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdin?.end();

    this.proc.stdout?.on('data', (data: Buffer) => {
      this.parseStreamJson(data);
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.emit('error-output', data.toString());
    });

    this.proc.on('error', (err) => {
      this.emit('error-output', err.message);
    });

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
    });
  }

  kill(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get killed(): boolean {
    return this.proc?.killed ?? false;
  }

  // ── Arg building ─────────────────────────────────────────────────────

  private buildArgs(): string[] {
    const args: string[] = [];

    if (this.config.resume) {
      args.push(
        '--resume', this.config.sessionId,
        '-p', this.config.prompt,
        '--output-format', 'stream-json',
        '--verbose',
      );
    } else {
      args.push(
        '-p', this.config.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--session-id', this.config.sessionId,
        '--model', this.config.model,
      );

      if (this.config.projectPrompt) {
        args.push('--project-prompt', this.config.projectPrompt);
      }
    }

    if (this.config.permissionMode) {
      args.push('--permission-mode', this.config.permissionMode);
    }
    if (this.config.allowedTools?.length) {
      args.push('--allowedTools', ...this.config.allowedTools);
    }
    if (this.config.disallowedTools?.length) {
      args.push('--disallowedTools', ...this.config.disallowedTools);
    }

    return args;
  }

  // ── Tool use summary ─────────────────────────────────────────────────

  private summarizeToolUse(name: string, input: Record<string, unknown>): string {
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
        return `Searching for "${String(input.pattern ?? '').slice(0, 60)}"${input.path ? ` in ${input.path}` : ''}`;
      case 'Glob':
        return `Finding files: ${input.pattern ?? ''}`;
      case 'Agent':
        return `Spawning sub-agent: ${input.description ?? ''}`;
      case 'Skill':
        return `Using skill: ${input.skill ?? ''}${input.args ? ` ${input.args}` : ''}`;
      case 'ToolSearch':
        return `Searching tools: ${input.query ?? ''}`;
      case 'TaskCreate':
        return `Creating task: ${input.description ?? ''}`;
      case 'TaskUpdate':
        return `Updating task: ${input.id ?? ''} → ${input.status ?? ''}`;
      default:
        return `Using ${name}`;
    }
  }

  // ── Stream-json parser ───────────────────────────────────────────────

  private parseStreamJson(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: StreamMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Result message (final)
      if (msg.type === 'result') {
        const cost: AdapterCostInfo = {
          totalUsd: msg.total_cost_usd ?? 0,
          inputTokens: msg.usage?.input_tokens ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
          cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0,
          durationMs: msg.duration_ms ?? 0,
        };
        this.emit('result', {
          result: msg.result ?? '',
          cost,
          sessionId: msg.session_id ?? this.config.sessionId,
        });
        continue;
      }

      // Assistant message with content blocks
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            this.emit('content', block.text);
            this.emit('activity', {
              id: this.nextActivityId(),
              kind: 'text',
              summary: block.text.slice(0, 200),
              content: block.text,
              timestamp: Date.now(),
            });
          } else if (block.type === 'tool_use' && block.name) {
            const input = block.input ?? {};
            this.emit('activity', {
              id: this.nextActivityId(),
              kind: 'tool_use',
              tool: block.name,
              summary: this.summarizeToolUse(block.name, input),
              content: JSON.stringify(input, null, 2),
              timestamp: Date.now(),
            });
          } else if (block.type === 'thinking' && block.text) {
            this.emit('activity', {
              id: this.nextActivityId(),
              kind: 'thinking',
              summary: block.text.slice(0, 200),
              content: block.text,
              timestamp: Date.now(),
            });
          }
        }
      }
    }
  }
}
