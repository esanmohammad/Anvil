/**
 * Circuit breaker — per-provider closed → open → half-open state machine.
 *
 * Trips when N consecutive non-retryable failures land within the active
 * window. While open the provider is skipped entirely (no adapter calls,
 * no rate-limit consumption); the fallback walker treats it as if the
 * step's `on` gate didn't match.
 *
 * Half-open after `cooldownMs`: a single probe call decides the next
 * state. Success → closed. Failure → re-opens with the same cooldown.
 *
 * Defaults per ADR R6:
 *   failureThreshold: 5
 *   cooldownMs: 30_000
 *   halfOpenAttempts: 1
 */

import type { CircuitBreakerConfig } from './types.js';

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenAttempts: 1,
};

export type CircuitState = 'closed' | 'open' | 'half_open';

interface ProviderState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  halfOpenInflight: number;
  /** Number of times this breaker has tripped — for telemetry. */
  tripCount: number;
}

export interface CircuitBreakerDeps {
  config?: CircuitBreakerConfig;
  /** Time source — injectable for deterministic tests. */
  now?: () => number;
}

/**
 * In-memory per-provider circuit breaker. Cross-process is overkill — the
 * router lifetime ≈ cli process lifetime, so reset-on-restart is fine.
 */
export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly states = new Map<string, ProviderState>();
  private readonly now: () => number;

  constructor(deps: CircuitBreakerDeps = {}) {
    this.config = deps.config ?? DEFAULT_CIRCUIT_BREAKER;
    this.now = deps.now ?? Date.now;
  }

  /** Whether the provider is allowed to take a new call right now. */
  canAttempt(provider: string): boolean {
    const s = this.peek(provider);
    if (s.state === 'closed') return true;
    if (s.state === 'open') {
      // Cooldown elapsed → transition to half-open.
      if (s.openedAt !== undefined && this.now() - s.openedAt >= this.config.cooldownMs) {
        s.state = 'half_open';
        s.halfOpenInflight = 0;
        return s.halfOpenInflight < this.config.halfOpenAttempts;
      }
      return false;
    }
    // half_open — let through up to halfOpenAttempts probes.
    return s.halfOpenInflight < this.config.halfOpenAttempts;
  }

  /**
   * Mark a probe as in-flight. Call before invoking the adapter so
   * concurrent probes don't all leak through.
   */
  reserveAttempt(provider: string): void {
    const s = this.stateOf(provider);
    if (s.state === 'half_open') s.halfOpenInflight += 1;
  }

  recordSuccess(provider: string): void {
    const s = this.stateOf(provider);
    s.state = 'closed';
    s.consecutiveFailures = 0;
    s.openedAt = undefined;
    s.halfOpenInflight = 0;
  }

  recordFailure(provider: string): void {
    const s = this.stateOf(provider);
    s.consecutiveFailures += 1;
    if (s.state === 'half_open') {
      // Re-open with full cooldown.
      s.state = 'open';
      s.openedAt = this.now();
      s.halfOpenInflight = 0;
      s.tripCount += 1;
      return;
    }
    if (s.state === 'closed' && s.consecutiveFailures >= this.config.failureThreshold) {
      s.state = 'open';
      s.openedAt = this.now();
      s.halfOpenInflight = 0;
      s.tripCount += 1;
    }
  }

  /** Inspect the current state for telemetry / tests. */
  inspect(provider: string): { state: CircuitState; tripCount: number } {
    const s = this.peek(provider);
    return { state: s.state, tripCount: s.tripCount };
  }

  /** Reset every breaker — useful in tests. */
  reset(): void {
    this.states.clear();
  }

  private stateOf(provider: string): ProviderState {
    let s = this.states.get(provider);
    if (!s) {
      s = { state: 'closed', consecutiveFailures: 0, halfOpenInflight: 0, tripCount: 0 };
      this.states.set(provider, s);
    }
    return s;
  }

  /**
   * Read state without auto-transitioning (used by canAttempt internally
   * via stateOf — alias kept for clarity).
   */
  private peek(provider: string): ProviderState {
    return this.stateOf(provider);
  }
}
