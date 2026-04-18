import type { ValidationCheck } from './runner.js';

export interface Regression {
  checkName: string;
  details: string;
}

/**
 * Detects new failures that were not present in the original results.
 * A regression is a check that passed (or was skipped) before but now fails.
 */
export function detectRegressions(
  beforeResults: ValidationCheck[],
  afterResults: ValidationCheck[],
): Regression[] {
  const regressions: Regression[] = [];

  const beforeMap = new Map<string, ValidationCheck>();
  for (const check of beforeResults) {
    beforeMap.set(check.name, check);
  }

  for (const afterCheck of afterResults) {
    const beforeCheck = beforeMap.get(afterCheck.name);

    // New failure: was passing/skipped before, now failing
    if (afterCheck.status === 'failed') {
      if (!beforeCheck || beforeCheck.status !== 'failed') {
        regressions.push({
          checkName: afterCheck.name,
          details: `Check "${afterCheck.name}" regressed: was ${beforeCheck?.status ?? 'not present'}, now failed. Output: ${afterCheck.output.slice(0, 500)}`,
        });
      }
    }
  }

  return regressions;
}
