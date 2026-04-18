import type { PersonaName } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePersonaPrompt(_name: PersonaName, content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!content || content.trim().length === 0) {
    return { valid: false, errors: ['Persona prompt is empty'], warnings: [] };
  }

  // Check required template variable
  if (!content.includes('{{project_yaml}}')) {
    errors.push('Missing required template variable: {{project_yaml}}');
  }

  // Check output format section
  if (!content.toLowerCase().includes('output format') && !content.toLowerCase().includes('output template')) {
    errors.push('Missing output format section');
  }

  // Check stage rules section
  if (!content.toLowerCase().includes('stage rule') && !content.toLowerCase().includes('rules')) {
    warnings.push('Missing stage rules section');
  }

  return { valid: errors.length === 0, errors, warnings };
}
