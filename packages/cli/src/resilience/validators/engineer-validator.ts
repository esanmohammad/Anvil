/**
 * EngineerValidator — Stage 5: validates git commits exist, code changes, task ID references.
 */

import type { StageValidator, ValidationResult } from '../validator-registry.js';

export class EngineerValidator implements StageValidator {
  readonly stageName = 'build';

  validate(output: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!output || output.trim().length === 0) {
      errors.push('Engineer output is empty');
      return { valid: false, errors, warnings };
    }

    // Should reference git commits
    const hasCommitRef =
      /\b(commit|committed|pushed|git\s+add|git\s+commit|[a-f0-9]{7,40})\b/i.test(output);
    if (!hasCommitRef) {
      errors.push('No git commit references detected in engineer output');
    }

    // Should reference code changes
    const hasCodeChanges =
      /\b(created|modified|updated|added|deleted|changed|wrote|implemented)\b.*\b(file|function|class|module|component|test)/i.test(
        output,
      ) || /\.(ts|js|tsx|jsx|py|go|rs|java)\b/.test(output);
    if (!hasCodeChanges) {
      warnings.push('No code file changes detected in engineer output');
    }

    // Should reference task IDs
    const hasTaskRef =
      /\b(task[-_]?\d|T\d{3,}|task\s+\d)/i.test(output);
    if (!hasTaskRef) {
      warnings.push('No task ID references detected in engineer output');
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
