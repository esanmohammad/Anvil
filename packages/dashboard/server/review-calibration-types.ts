/**
 * Calibration shapes for the review-confidence loop.
 */

export type CalibrationOutcome = 'accepted' | 'dismissed' | 'wontFix' | 'applied-patch' | 'pending';

export interface CalibrationOutcomeEvent {
  personaId: string;
  statedConfidence: number;
  outcome: CalibrationOutcome;
  at: string;
}

export interface PersonaSnapshot {
  personaId: string;
  findingsSeen: number;
  accepted: number;
  dismissed: number;
  wontFix: number;
  empiricalAcceptRate: number;
  statedConfidenceMean: number;
  calibrationDelta: number;
  lastUpdatedAt: string;
}

export interface CalibrationSnapshotBundle {
  project: string;
  window: number;
  personas: PersonaSnapshot[];
  computedAt: string;
}
