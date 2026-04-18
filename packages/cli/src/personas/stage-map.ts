import type { PersonaName } from './types.js';

export const STAGE_PERSONA_MAP: Record<string, PersonaName> = {
  'clarify': 'clarifier',
  'high-level-requirements': 'analyst',
  'requirements': 'analyst',
  'spec': 'architect',
  'tasks': 'lead',
  'build': 'engineer',
  'test': 'tester',
};

export const PIPELINE_STAGES = Object.keys(STAGE_PERSONA_MAP);

export function getPersonaForStage(stage: string): PersonaName {
  const persona = STAGE_PERSONA_MAP[stage];
  if (!persona) throw new Error(`Unknown pipeline stage: ${stage}`);
  return persona;
}

export function getStagesForPersona(persona: PersonaName): string[] {
  return Object.entries(STAGE_PERSONA_MAP)
    .filter(([_, p]) => p === persona)
    .map(([stage]) => stage);
}
