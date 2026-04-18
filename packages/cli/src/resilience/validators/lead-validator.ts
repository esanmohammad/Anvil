/**
 * LeadValidator — Stage 4: validates task items, repo grouping, dependency markers.
 */

import type { StageValidator, ValidationResult } from '../validator-registry.js';

export class LeadValidator implements StageValidator {
  readonly stageName = 'tasks';

  validate(output: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output || output.trim().length === 0) {
      errors.push('Lead output is empty');
      return { valid: false, errors, warnings };
    }

    // Should contain task items (numbered lists, bullets, task IDs)
    const hasTaskItems =
      /(\d+\.\s|\-\s\[|\*\s|task[-_]?\d|T\d{3,})/i.test(output);
    if (!hasTaskItems) {
      errors.push('No task items detected in lead output');
    }

    // Should be grouped by repo
    const hasRepoGrouping =
      /\b(repo|repository|package|project|service)\b/i.test(output);
    if (!hasRepoGrouping) {
      warnings.push('Tasks may not be grouped by repository');
    }

    // Should have dependency markers
    const hasDependencyMarkers =
      /\b(depends?\s+on|blocks?|after|before|prerequisite|blocked\s+by|requires)/i.test(output);
    if (!hasDependencyMarkers) {
      warnings.push('No dependency markers detected between tasks');
    }

    // Minimum length
    if (output.trim().length < 100) {
      errors.push('Lead output is too short (< 100 chars)');
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
