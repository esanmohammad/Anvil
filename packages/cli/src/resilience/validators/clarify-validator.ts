/**
 * ClarifyValidator — Stage 0: validates Q&A pairs, feature request references.
 */

import type { StageValidator, ValidationResult } from '../validator-registry.js';

export class ClarifyValidator implements StageValidator {
  readonly stageName = 'clarify';

  validate(output: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output || output.trim().length === 0) {
      errors.push('Clarify output is empty');
      return { valid: false, errors, warnings };
    }

    // Must contain Q&A pairs (question/answer patterns)
    const hasQA =
      /\b(Q:|Question:|A:|Answer:|\?.*\n)/i.test(output) ||
      /\b(clarif|question|answer|ask)/i.test(output);
    if (!hasQA) {
      warnings.push('No Q&A pairs detected in clarify output');
    }

    // Should reference the feature request
    const hasFeatureRef =
      /\b(feature|request|requirement|user\s+wants|goal)/i.test(output);
    if (!hasFeatureRef) {
      errors.push('Clarify output does not reference the feature request');
    }

    // Minimum content length
    if (output.trim().length < 50) {
      errors.push('Clarify output is too short (< 50 chars)');
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
