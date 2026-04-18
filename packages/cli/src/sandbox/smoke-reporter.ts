// Generate a Markdown report from smoke test results

import type { SmokeTestResult, StepResult } from './smoke-runner.js';
import type { FixAttempt } from './smoke-fix-loop.js';

/**
 * Format a Markdown smoke test report including results and fix history.
 */
export function formatSmokeReport(
  results: SmokeTestResult[],
  fixHistory: FixAttempt[] = [],
): string {
  const lines: string[] = [];

  lines.push('# Smoke Test Report');
  lines.push('');

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;
  lines.push(`**Status:** ${allPassed ? 'PASSED' : 'FAILED'}`);
  lines.push(`**Flows:** ${passed}/${total} passed`);
  lines.push('');

  // Flow details
  lines.push('## Flow Results');
  lines.push('');

  for (const result of results) {
    const icon = result.passed ? '[PASS]' : '[FAIL]';
    lines.push(`### ${icon} ${result.flowName} (${result.flowId})`);
    lines.push('');

    if (result.stepResults.length > 0) {
      lines.push('| Step | Status | Latency | Details |');
      lines.push('|------|--------|---------|---------|');

      for (const step of result.stepResults) {
        lines.push(formatStepRow(step));
      }
      lines.push('');
    }
  }

  // Fix history
  if (fixHistory.length > 0) {
    lines.push('## Fix History');
    lines.push('');

    for (const attempt of fixHistory) {
      lines.push(
        `- **Attempt ${attempt.attempt}:** ${attempt.fixed ? 'Fix applied' : 'Fix failed'} (failed flows: ${attempt.failedFlows.join(', ')})`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatStepRow(step: StepResult): string {
  const icon = step.passed ? 'PASS' : 'FAIL';
  const latency = `${step.latencyMs}ms`;
  const details = step.error
    ? step.error
    : `HTTP ${step.status} (expected ${step.expectedStatus})`;
  return `| ${step.name} | ${icon} | ${latency} | ${details} |`;
}
