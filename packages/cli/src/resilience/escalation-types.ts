/**
 * Escalation types and chain configuration.
 */

export enum EscalationLevel {
  Engineer = 'engineer',
  Lead = 'lead',
  Architect = 'architect',
  Analyst = 'analyst',
  Human = 'human',
}

/** The escalation chain in order from lowest to highest. */
export const ESCALATION_CHAIN: EscalationLevel[] = [
  EscalationLevel.Engineer,
  EscalationLevel.Lead,
  EscalationLevel.Architect,
  EscalationLevel.Analyst,
  EscalationLevel.Human,
];

export interface EscalationEvent {
  id: string;
  level: EscalationLevel;
  previousLevel: EscalationLevel | null;
  reason: string;
  stageName: string;
  timestamp: string;
  failureCount: number;
  resolved: boolean;
}

export interface EscalationChainConfig {
  /** Failure count threshold per level before escalating. Default 2. */
  thresholdPerLevel: number;
  /** Whether to skip directly to human on critical errors. Default false. */
  skipToHumanOnCritical: boolean;
}

export const DEFAULT_ESCALATION_CONFIG: EscalationChainConfig = {
  thresholdPerLevel: 2,
  skipToHumanOnCritical: false,
};

/** Get the next escalation level in the chain. Returns null if already at Human. */
export function getNextLevel(current: EscalationLevel): EscalationLevel | null {
  const idx = ESCALATION_CHAIN.indexOf(current);
  if (idx === -1 || idx >= ESCALATION_CHAIN.length - 1) return null;
  return ESCALATION_CHAIN[idx + 1];
}
