/**
 * Gemini CLI adapter — spawns the `gemini` binary.
 *
 * Key differences from Claude CLI:
 *   - No --output-format stream-json (plain text stdout)
 *   - No --session-id, --verbose, --permission-mode, --project-prompt
 *   - Supports: -p <prompt>, --model <model>, --sandbox
 *   - No session resume — spawns fresh process each time
 *   - No cost/token reporting
 */

import { spawn, ChildProcess } from 'node:child_process';
import { BaseAdapter, type AdapterConfig } from './base-adapter.js';

const GEMINI_BIN = process.env.GEMINI_BIN ?? 'gemini';

export class GeminiCliAdapter extends BaseAdapter {
  private proc: ChildProcess | null = null;
  private fullOutput = '';
  private startTime = 0;

  constructor(config: AdapterConfig) {
    super(config);
  }

  start(): void {
    this.startTime = Date.now();
    const args = this.buildArgs();

    this.proc = spawn(GEMINI_BIN, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.proc.stdin?.end();

    // Gemini CLI outputs plain text — stream chunks as they arrive
    this.proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      this.fullOutput += chunk;

      this.emit('content', chunk);
      this.emit('activity', {
        id: this.nextActivityId(),
        kind: 'text',
        summary: chunk.slice(0, 200).replace(/\n/g, ' '),
        content: chunk,
        timestamp: Date.now(),
      });
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Gemini CLI prints progress/status to stderr — forward as error-output
      // but don't treat informational messages as errors
      this.emit('error-output', text);
    });

    this.proc.on('error', (err) => {
      this.emit('error-output', `Failed to start gemini CLI: ${err.message}`);
      this.emit('exit', 1);
    });

    this.proc.on('exit', (code) => {
      const durationMs = Date.now() - this.startTime;

      // Synthesize a result event from accumulated output
      if (this.fullOutput.trim()) {
        this.emit('result', {
          result: this.fullOutput.trim(),
          cost: { ...this.zeroCost(), durationMs },
          sessionId: this.config.sessionId,
        });
      }

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

  private buildArgs(): string[] {
    const args: string[] = [];

    // Combine project prompt + user prompt since Gemini CLI
    // doesn't have a separate --system-prompt or --project-prompt flag
    let fullPrompt = this.config.prompt;
    if (this.config.projectPrompt) {
      fullPrompt = `${this.config.projectPrompt}\n\n---\n\n${this.config.prompt}`;
    }

    args.push('-p', fullPrompt);

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    return args;
  }
}
