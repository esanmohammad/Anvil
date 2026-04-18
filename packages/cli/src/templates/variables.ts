import type { PersonaName } from '../personas/types.js';

export interface TemplateVariable {
  name: string;
  description: string;
  requiredFor: PersonaName[];
}

export const VARIABLE_REGISTRY: Record<string, TemplateVariable> = {
  project_yaml: { name: 'project_yaml', description: 'Full project.yaml content', requiredFor: ['clarifier', 'analyst', 'architect', 'lead', 'engineer', 'tester'] },
  feature_request: { name: 'feature_request', description: 'The user feature request', requiredFor: ['clarifier'] },
  existing_clarifications: { name: 'existing_clarifications', description: 'Previously answered clarification questions', requiredFor: [] },
  clarification_md: { name: 'clarification_md', description: 'Clarification stage output', requiredFor: ['analyst'] },
  requirements_md: { name: 'requirements_md', description: 'Requirements stage output', requiredFor: ['architect'] },
  spec_md: { name: 'spec_md', description: 'Architecture spec output', requiredFor: ['lead'] },
  task: { name: 'task', description: 'Current task to implement', requiredFor: ['engineer', 'tester'] },
  conventions: { name: 'conventions', description: 'Code conventions for the project', requiredFor: [] },
  memories: { name: 'memories', description: 'Relevant memories from prior runs', requiredFor: [] },
  invariants: { name: 'invariants', description: 'Project invariants from project.yaml', requiredFor: ['architect', 'tester'] },
  sharp_edges: { name: 'sharp_edges', description: 'Project sharp edges from project.yaml', requiredFor: ['architect'] },
  repo_context: { name: 'repo_context', description: 'Repository-specific context and structure', requiredFor: ['engineer'] },
  existing_code: { name: 'existing_code', description: 'Existing code in affected files', requiredFor: ['engineer'] },
  code_changes: { name: 'code_changes', description: 'Code changes from build stage', requiredFor: ['tester'] },
};

export function getRequiredVariables(persona: PersonaName): string[] {
  return Object.values(VARIABLE_REGISTRY)
    .filter(v => v.requiredFor.includes(persona))
    .map(v => v.name);
}
