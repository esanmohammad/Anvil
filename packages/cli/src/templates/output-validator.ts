import type { PersonaName } from '../personas/types.js';
import { getOutputTemplate } from './outputs.js';

export interface OutputValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateOutput(
  persona: PersonaName,
  output: string,
  variant?: string,
): OutputValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!output || output.trim().length === 0) {
    return { valid: false, errors: ['Output is empty'], warnings: [] };
  }

  let template;
  try {
    template = getOutputTemplate(persona, variant);
  } catch {
    return { valid: false, errors: [`No output template for persona: ${persona}`], warnings: [] };
  }

  // Check required sections
  const headingRegex = /^#{1,3}\s+(.+)$/gm;
  const headings = new Set<string>();
  let match;
  while ((match = headingRegex.exec(output)) !== null) {
    headings.add(match[1].trim().toLowerCase());
  }

  for (const section of template.requiredSections) {
    if (!headings.has(section.toLowerCase())) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  // Persona-specific validation
  if (persona === 'analyst' && !output.match(/project/i)) {
    errors.push('Analyst output must reference at least one project');
  }

  if (persona === 'lead' && !output.match(/T\d+|task[-\s]?\d+/i)) {
    errors.push('Lead output must include task IDs');
  }

  if (persona === 'tester' && !output.match(/pass|fail/i)) {
    errors.push('Tester output must include pass/fail status');
  }

  return { valid: errors.length === 0, errors, warnings };
}
