/**
 * Agent Process Manager — crash detection and auto-restart policy.
 */

export class RestartPolicy {
  private attempts = 0;
  private readonly maxRestarts: number;

  constructor(maxRestarts = 2) {
    this.maxRestarts = maxRestarts;
  }

  /**
   * Determine whether the agent should be restarted given the exit details.
   *
   * Does NOT restart on:
   *  - exit code 0 (clean exit)
   *  - SIGTERM (graceful kill, e.g. from timeout)
   *
   * Restarts on non-zero exit codes while under maxRestarts.
   */
  shouldRestart(exitCode: number, signal?: string): boolean {
    if (exitCode === 0) return false;
    if (signal === 'SIGTERM') return false;
    return !this.isExhausted();
  }

  /** Current restart attempt (0 = initial run). */
  getAttempt(): number {
    return this.attempts;
  }

  /** Record that a restart has occurred. */
  recordRestart(): void {
    this.attempts += 1;
  }

  /** Have we exhausted all allowed restarts? */
  isExhausted(): boolean {
    return this.attempts >= this.maxRestarts;
  }

  /**
   * Build a context string to inject into a restarted agent so it can resume
   * from where it left off.
   */
  getRestartContext(priorOutput: string): string {
    const truncated =
      priorOutput.length > 2000
        ? priorOutput.slice(priorOutput.length - 2000)
        : priorOutput;
    return [
      `[RESTART] This is restart attempt ${this.attempts + 1} of ${this.maxRestarts}.`,
      'The previous run crashed. Here is the tail of its output:',
      '---',
      truncated,
      '---',
      'Please continue from where it left off.',
    ].join('\n');
  }
}
