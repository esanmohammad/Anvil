/**
 * EscalationEngine — tracks failure counts and triggers escalation along the chain.
 */

import { randomUUID } from 'node:crypto';
import {
  EscalationLevel,
  ESCALATION_CHAIN,
  DEFAULT_ESCALATION_CONFIG,
  getNextLevel,
  type EscalationEvent,
  type EscalationChainConfig,
} from './escalation-types.js';

export class EscalationEngine {
  private config: EscalationChainConfig;
  private failureCounts: Map<string, number> = new Map();
  private currentLevels: Map<string, EscalationLevel> = new Map();
  private events: EscalationEvent[] = [];

  constructor(config?: Partial<EscalationChainConfig>) {
    this.config = { ...DEFAULT_ESCALATION_CONFIG, ...config };
  }

  /** Record a failure for a stage. Returns the escalation event if escalation occurs. */
  recordFailure(stageName: string, reason: string): EscalationEvent | null {
    const key = stageName;
    const count = (this.failureCounts.get(key) ?? 0) + 1;
    this.failureCounts.set(key, count);

    if (count >= this.config.thresholdPerLevel) {
      return this.escalate(stageName, reason);
    }
    return null;
  }

  /** Force escalation for a stage. */
  escalate(stageName: string, reason: string): EscalationEvent {
    const currentLevel =
      this.currentLevels.get(stageName) ?? ESCALATION_CHAIN[0];
    const nextLevel = getNextLevel(currentLevel);

    const event: EscalationEvent = {
      id: randomUUID(),
      level: nextLevel ?? EscalationLevel.Human,
      previousLevel: currentLevel,
      reason,
      stageName,
      timestamp: new Date().toISOString(),
      failureCount: this.failureCounts.get(stageName) ?? 0,
      resolved: false,
    };

    this.currentLevels.set(stageName, event.level);
    this.failureCounts.set(stageName, 0); // reset count for new level
    this.events.push(event);
    return event;
  }

  /** Force escalation directly to human level. */
  escalateToHuman(stageName: string, reason: string): EscalationEvent {
    const currentLevel = this.currentLevels.get(stageName) ?? null;
    const event: EscalationEvent = {
      id: randomUUID(),
      level: EscalationLevel.Human,
      previousLevel: currentLevel,
      reason,
      stageName,
      timestamp: new Date().toISOString(),
      failureCount: this.failureCounts.get(stageName) ?? 0,
      resolved: false,
    };

    this.currentLevels.set(stageName, EscalationLevel.Human);
    this.events.push(event);
    return event;
  }

  /** Mark an escalation as resolved. */
  resolve(eventId: string): boolean {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) return false;
    event.resolved = true;
    return true;
  }

  /** Get current escalation level for a stage. */
  getCurrentLevel(stageName: string): EscalationLevel | null {
    return this.currentLevels.get(stageName) ?? null;
  }

  /** Get failure count for a stage. */
  getFailureCount(stageName: string): number {
    return this.failureCounts.get(stageName) ?? 0;
  }

  /** Get all escalation events. */
  getEvents(): readonly EscalationEvent[] {
    return this.events;
  }

  /** Check if a stage has reached human escalation. */
  isAtHumanLevel(stageName: string): boolean {
    return this.currentLevels.get(stageName) === EscalationLevel.Human;
  }

  /** Reset all state. */
  reset(): void {
    this.failureCounts.clear();
    this.currentLevels.clear();
    this.events = [];
  }
}
