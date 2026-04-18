import type { PersonaName } from '../personas/types.js';
import type { OutputTemplate } from '../personas/types.js';

const OUTPUT_TEMPLATES: Record<string, OutputTemplate> = {
  clarifier: {
    filename: 'CLARIFICATION.md',
    requiredSections: ['Summary', 'Questions & Answers', 'Assumptions', 'Scope Boundaries', 'Affected Projects'],
  },
  'analyst-high-level': {
    filename: 'HIGH-LEVEL-REQUIREMENTS.md',
    requiredSections: ['Feature Overview', 'Affected Projects', 'Cross-Project Dependencies', 'Success Criteria', 'Risks'],
  },
  'analyst-per-project': {
    filename: 'requirements/{{project}}/REQUIREMENTS.md',
    requiredSections: ['Project Context', 'Functional Requirements', 'Non-Functional Requirements', 'Data Requirements', 'Integration Points', 'Acceptance Criteria'],
  },
  architect: {
    filename: 'specs/{{project}}/SPEC.md',
    requiredSections: ['Architecture Overview', 'Component Design', 'API Design', 'Data Model Changes', 'Infrastructure Changes', 'Security Considerations', 'Rollback Strategy'],
  },
  lead: {
    filename: 'tasks/{{project}}/TASKS.md',
    requiredSections: ['Task Overview', 'Task List', 'Dependencies'],
  },
  engineer: {
    filename: 'code-changes',
    requiredSections: ['Changed Files', 'Tests'],
  },
  tester: {
    filename: 'TEST-REPORT.md',
    requiredSections: ['Test Results', 'Build Status', 'Lint Results', 'Invariant Check', 'Coverage Delta', 'Recommendations'],
  },
};

export function getOutputTemplate(persona: PersonaName | string, variant?: string): OutputTemplate {
  const key = variant ? `${persona}-${variant}` : persona;
  const template = OUTPUT_TEMPLATES[key];
  if (!template) throw new Error(`No output template for: ${key}`);
  return template;
}

export function getAllOutputTemplates(): Record<string, OutputTemplate> {
  return { ...OUTPUT_TEMPLATES };
}
