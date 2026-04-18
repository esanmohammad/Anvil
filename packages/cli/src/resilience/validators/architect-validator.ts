/**
 * ArchitectValidator — Stage 3: validates specs reference repos, APIs, dependencies.
 */

import type { StageValidator, ValidationResult } from '../validator-registry.js';

export class ArchitectValidator implements StageValidator {
  readonly stageName = 'specs';

  validate(output: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output || output.trim().length === 0) {
      errors.push('Architect output is empty');
      return { valid: false, errors, warnings };
    }

    // Should reference repos
    const hasRepoRef =
      /\b(repo|repository|codebase|packages?\/|src\/)/i.test(output);
    if (!hasRepoRef) {
      warnings.push('No repository references detected in architect output');
    }

    // Should contain API or schema references
    const hasApiRef =
      /\b(api|endpoint|schema|interface|type|model|contract|route|handler)/i.test(output);
    if (!hasApiRef) {
      errors.push('Architect output does not reference APIs or schemas');
    }

    // Should mention dependency ordering
    const hasDependencyOrder =
      /\b(depend|order|sequenc|before|after|block|prerequisite|first|then)/i.test(output);
    if (!hasDependencyOrder) {
      warnings.push('No dependency ordering detected in architect output');
    }

    // Should not be a placeholder template
    const isTemplate =
      /\[INSERT|TODO:|PLACEHOLDER|<FILL|TBD\b/i.test(output);
    if (isTemplate) {
      errors.push('Architect output appears to be a generic template');
    }

    // Minimum length
    if (output.trim().length < 150) {
      errors.push('Architect output is too short (< 150 chars)');
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
