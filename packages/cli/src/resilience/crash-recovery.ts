/**
 * CrashRecovery — detects non-zero exit codes, injects context into restart prompts.
 */

export interface CrashAttempt {
  exitCode: number;
  timestamp: string;
  lastOutputLines: string[];
  restartNumber: number;
}

export interface CrashRecoveryConfig {
  /** Max restart attempts before escalation. Default 2. */
  maxRestarts: number;
  /** Number of output lines to capture for restart context. Default 200. */
  tailLines: number;
}

const DEFAULT_CONFIG: CrashRecoveryConfig = {
  maxRestarts: 2,
  tailLines: 200,
};

export class CrashRecovery {
  private config: CrashRecoveryConfig;
  private attempts: CrashAttempt[] = [];

  constructor(config?: Partial<CrashRecoveryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Record a crash attempt. Returns whether a restart is allowed. */
  recordAttempt(exitCode: number, outputLines: string[]): boolean {
    const tail = outputLines.slice(-this.config.tailLines);
    this.attempts.push({
      exitCode,
      timestamp: new Date().toISOString(),
      lastOutputLines: tail,
      restartNumber: this.attempts.length + 1,
    });
    return this.canRestart();
  }

  /** Whether another restart is allowed. */
  canRestart(): boolean {
    return this.attempts.length < this.config.maxRestarts;
  }

  /** Whether restarts have been exhausted (should escalate). */
  isExhausted(): boolean {
    return this.attempts.length >= this.config.maxRestarts;
  }

  /** Get the restart prompt injection with context from the last crash. */
  getRestartPrompt(): string {
    const last = this.attempts[this.attempts.length - 1];
    if (!last) return '';
    const context = last.lastOutputLines.join('\n');
    return [
      `[RESTART ${last.restartNumber}/${this.config.maxRestarts}]`,
      `Previous agent exited with code ${last.exitCode}.`,
      'Last output before crash:',
      '```',
      context,
      '```',
      'Please continue from where the previous agent left off.',
    ].join('\n');
  }

  /** Get all recorded crash attempts. */
  getAttempts(): readonly CrashAttempt[] {
    return this.attempts;
  }

  /** Reset all attempts. */
  reset(): void {
    this.attempts = [];
  }
}
