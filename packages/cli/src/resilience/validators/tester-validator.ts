/**
 * TesterValidator — Stage 6: validates test results, pass/fail counts, test file references.
 */

import type { StageValidator, ValidationResult } from '../validator-registry.js';

export class TesterValidator implements StageValidator {
  readonly stageName = 'validate';

  validate(output: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output || output.trim().length === 0) {
      errors.push('Tester output is empty');
      return { valid: false, errors, warnings };
    }

    // Should contain test results
    const hasTestResults =
      /\b(pass(ed|ing)?|fail(ed|ing)?|success|error|test\s+result|test\s+suite)/i.test(output);
    if (!hasTestResults) {
      errors.push('No test results detected in tester output');
    }

    // Should have pass/fail counts
    const hasCounts =
      /\d+\s*(pass|fail|test|spec|suite|success|error)/i.test(output) ||
      /\b(all\s+\d+|passed\s+\d+|\d+\s+passed)/i.test(output);
    if (!hasCounts) {
      warnings.push('No pass/fail counts detected in tester output');
    }

    // Should reference test files
    const hasTestFileRef =
      /\.(test|spec)\.(ts|js|tsx|jsx)\b/.test(output) ||
      /\b(test\s+file|test\s+suite|describe|it\()/i.test(output);
    if (!hasTestFileRef) {
      warnings.push('No test file references detected in tester output');
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
