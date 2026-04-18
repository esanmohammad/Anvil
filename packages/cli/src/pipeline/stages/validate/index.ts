import type { AgentRunner } from '../types.js';
import { runValidationChecks, type RepoValidation, type ValidationCheck } from './runner.js';
import { targetFailure, type FailureFix } from './failure-targeter.js';

export type { ValidationCheck, RepoValidation } from './runner.js';
export type { Invariant, InvariantViolation } from './invariant-checker.js';
export type { FailureFix } from './failure-targeter.js';
export type { Regression } from './regression-detector.js';
export type { EscalationLevel, EscalationResult } from './escalation.js';
export { runValidationChecks } from './runner.js';
export { checkInvariants } from './invariant-checker.js';
export { targetFailure } from './failure-targeter.js';
export { detectRegressions } from './regression-detector.js';
export { EscalationChain } from './escalation.js';

export interface FixLoopResult {
  allPassed: boolean;
  iterations: number;
  repoResults: RepoValidation[];
  fixHistory: FailureFix[];
  validationMd: string;
}

/**
 * Runs a fix loop: validate → fix failures → re-validate, up to maxIterations.
 */
export async function runFixLoop(
  repoPaths: Record<string, string>,
  languages: Record<string, 'typescript' | 'go' | 'unknown'>,
  agentRunner: AgentRunner,
  maxIterations: number = 5,
): Promise<FixLoopResult> {
  const fixHistory: FailureFix[] = [];
  let repoResults: RepoValidation[] = [];
  let allPassed = false;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    // Run validation for all repos
    repoResults = [];
    for (const [repoName, repoPath] of Object.entries(repoPaths)) {
      const language = languages[repoName] ?? 'unknown';
      const result = await runValidationChecks(repoPath, repoName, language);
      repoResults.push(result);
    }

    // Check if everything passed
    allPassed = repoResults.every((r) => r.allPassed);
    if (allPassed) break;

    // Try to fix failures
    const failures: Array<{ check: ValidationCheck; repoPath: string }> = [];
    for (const repo of repoResults) {
      for (const check of repo.checks) {
        if (check.status === 'failed') {
          failures.push({ check, repoPath: repo.repoPath });
        }
      }
    }

    if (failures.length === 0) {
      allPassed = true;
      break;
    }

    // Attempt fixes
    for (const { check, repoPath } of failures) {
      const fix = await targetFailure(check, repoPath, agentRunner);
      fixHistory.push(fix);
    }
  }

  // Generate VALIDATION.md content
  const validationMd = generateValidationMd(repoResults, fixHistory, iteration);

  return {
    allPassed,
    iterations: iteration,
    repoResults,
    fixHistory,
    validationMd,
  };
}

function generateValidationMd(
  repoResults: RepoValidation[],
  fixHistory: FailureFix[],
  iterations: number,
): string {
  const lines: string[] = [
    '# Validation Report',
    '',
    `**Iterations:** ${iterations}`,
    `**Status:** ${repoResults.every((r) => r.allPassed) ? 'PASSED' : 'FAILED'}`,
    '',
  ];

  for (const repo of repoResults) {
    lines.push(`## ${repo.repoName}`);
    lines.push('');
    for (const check of repo.checks) {
      const icon = check.status === 'passed' ? 'PASS' : check.status === 'failed' ? 'FAIL' : 'SKIP';
      lines.push(`- [${icon}] ${check.name} (${check.duration}ms)`);
    }
    lines.push('');
  }

  if (fixHistory.length > 0) {
    lines.push('## Fix History');
    lines.push('');
    for (const fix of fixHistory) {
      lines.push(`- ${fix.failure}: ${fix.status}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
