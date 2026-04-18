/**
 * EscalationHandlers — per-level escalation response strategies.
 */

import { EscalationLevel, type EscalationEvent } from './escalation-types.js';

export interface EscalationAction {
  level: EscalationLevel;
  action: string;
  description: string;
  pausePipeline: boolean;
  restartFromStage?: string;
}

export interface EscalationHandler {
  level: EscalationLevel;
  handle(event: EscalationEvent): EscalationAction;
}

export class LeadEscalationHandler implements EscalationHandler {
  readonly level = EscalationLevel.Lead;

  handle(event: EscalationEvent): EscalationAction {
    return {
      level: this.level,
      action: 're-plan',
      description: `Lead re-planning tasks for stage "${event.stageName}" after ${event.failureCount} failures: ${event.reason}`,
      pausePipeline: false,
      restartFromStage: 'tasks',
    };
  }
}

export class ArchitectEscalationHandler implements EscalationHandler {
  readonly level = EscalationLevel.Architect;

  handle(event: EscalationEvent): EscalationAction {
    return {
      level: this.level,
      action: 're-spec',
      description: `Architect re-specifying for stage "${event.stageName}": ${event.reason}`,
      pausePipeline: false,
      restartFromStage: 'specs',
    };
  }
}

export class AnalystEscalationHandler implements EscalationHandler {
  readonly level = EscalationLevel.Analyst;

  handle(event: EscalationEvent): EscalationAction {
    return {
      level: this.level,
      action: 're-analyze',
      description: `Analyst re-analyzing requirements for stage "${event.stageName}": ${event.reason}`,
      pausePipeline: false,
      restartFromStage: 'requirements',
    };
  }
}

export class HumanEscalationHandler implements EscalationHandler {
  readonly level = EscalationLevel.Human;

  handle(event: EscalationEvent): EscalationAction {
    return {
      level: this.level,
      action: 'pause',
      description: `Pipeline paused for human intervention on stage "${event.stageName}": ${event.reason}`,
      pausePipeline: true,
    };
  }
}

/** Get the handler for a given escalation level. */
export function getHandlerForLevel(level: EscalationLevel): EscalationHandler | null {
  switch (level) {
    case EscalationLevel.Lead:
      return new LeadEscalationHandler();
    case EscalationLevel.Architect:
      return new ArchitectEscalationHandler();
    case EscalationLevel.Analyst:
      return new AnalystEscalationHandler();
    case EscalationLevel.Human:
      return new HumanEscalationHandler();
    default:
      return null;
  }
}

/** Handle an escalation event by finding and invoking the appropriate handler. */
export function handleEscalation(event: EscalationEvent): EscalationAction | null {
  const handler = getHandlerForLevel(event.level);
  if (!handler) return null;
  return handler.handle(event);
}
