/**
 * AnalystValidator — Stages 1+2: validates requirements reference projects and success criteria.
 */

import type { StageValidator, ValidationResult } from '../validator-registry.js';

export class AnalystValidator implements StageValidator {
  readonly stageName = 'requirements';

  validate(output: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output || output.trim().length === 0) {
      errors.push('Analyst output is empty');
      return { valid: false, errors, warnings };
    }

    // Should reference projects
    const hasProjectRef =
      /\b(project|service|component|module|repo|repository)/i.test(output);
    if (!hasProjectRef) {
      errors.push('Analyst output does not reference any projects');
    }

    // Should contain success criteria
    const hasSuccessCriteria =
      /\b(success\s+criteri|acceptance\s+criteri|done\s+when|definition\s+of\s+done|must|should|shall)/i.test(
        output,
      );
    if (!hasSuccessCriteria) {
      warnings.push('No success criteria detected in analyst output');
    }

    // Should not be a generic template (detect placeholder markers)
    const isTemplate =
      /\[INSERT|TODO:|PLACEHOLDER|<FILL|TBD\b/i.test(output);
    if (isTemplate) {
      errors.push('Analyst output appears to be a generic template with placeholders');
    }

    // Minimum length
    if (output.trim().length < 100) {
      errors.push('Analyst output is too short (< 100 chars)');
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}

/** Validator for project-requirements stage (stage 2). */
export class ProjectRequirementsValidator implements StageValidator {
  readonly stageName = 'project-requirements';
  private inner = new AnalystValidator();

  validate(output: string): ValidationResult {
    return this.inner.validate(output);
  }
}
