/**
 * HeartbeatMonitor — tracks agent output frequency and detects stalls.
 */

import { EventEmitter } from 'node:events';

export interface HeartbeatConfig {
  /** Max silence before emitting 'stall' (ms). Default 60_000. */
  stallThresholdMs: number;
  /** Grace period after "thinking" signals (ms). Default 120_000. */
  thinkingGraceMs: number;
}

const DEFAULT_CONFIG: HeartbeatConfig = {
  stallThresholdMs: 60_000,
  thinkingGraceMs: 120_000,
};

export class HeartbeatMonitor extends EventEmitter {
  private config: HeartbeatConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBeatAt: number = 0;
  private thinking: boolean = false;
  private running: boolean = false;

  constructor(config?: Partial<HeartbeatConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start monitoring. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastBeatAt = Date.now();
    this.scheduleCheck();
  }

  /** Stop monitoring and clear timers. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reset the heartbeat (call on each output chunk). */
  reset(): void {
    this.lastBeatAt = Date.now();
    this.thinking = false;
  }

  /** Mark the agent as "thinking" (extended grace period). */
  markThinking(): void {
    this.thinking = true;
    this.lastBeatAt = Date.now();
  }

  /** Whether the monitor is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Whether the agent is in thinking mode. */
  isThinking(): boolean {
    return this.thinking;
  }

  /** Get the elapsed silence duration in ms. */
  getSilenceDuration(): number {
    return Date.now() - this.lastBeatAt;
  }

  private scheduleCheck(): void {
    if (!this.running) return;
    const threshold = this.thinking
      ? this.config.thinkingGraceMs
      : this.config.stallThresholdMs;
    const elapsed = Date.now() - this.lastBeatAt;
    const delay = Math.max(threshold - elapsed, 100);

    this.timer = setTimeout(() => {
      if (!this.running) return;
      const silence = Date.now() - this.lastBeatAt;
      const limit = this.thinking
        ? this.config.thinkingGraceMs
        : this.config.stallThresholdMs;
      if (silence >= limit) {
        this.emit('stall', {
          silenceMs: silence,
          wasThinking: this.thinking,
        });
      }
      this.scheduleCheck();
    }, delay);
  }
}
