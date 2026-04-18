// Review reporter — Wave 9, Section B
// Formats review results as a markdown report

import type { DiffReviewResult } from './diff-reviewer.js';
import type { ConventionCheckResult } from './convention-checker.js';

export interface ReviewReport {
  markdown: string;
  overallScore: number;
  totalIssues: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

/**
 * Format diff review results and convention check results into a markdown report.
 */
export function formatReviewReport(
  diffResults: DiffReviewResult[],
  conventionResult?: ConventionCheckResult,
): ReviewReport {
  const lines: string[] = [];

  // Count totals across diff reviews
  let totalIssues = 0;
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const result of diffResults) {
    for (const issue of result.issues) {
      totalIssues++;
      if (issue.severity === 'error') errorCount++;
      else if (issue.severity === 'warning') warningCount++;
      else infoCount++;
    }
  }

  // Add convention violations
  if (conventionResult) {
    totalIssues += conventionResult.totalViolations;
    errorCount += conventionResult.violations.filter((v) => v.severity === 'error').length;
    warningCount += conventionResult.violations.filter((v) => v.severity === 'warning').length;
    infoCount += conventionResult.violations.filter((v) => v.severity === 'info').length;
  }

  // Compute overall score
  const diffScores = diffResults.map((r) => r.score);
  const avgDiffScore = diffScores.length > 0
    ? diffScores.reduce((a, b) => a + b, 0) / diffScores.length
    : 100;
  const conventionScore = conventionResult?.score ?? 100;
  const overallScore = Math.round((avgDiffScore + conventionScore) / 2);

  // Header
  lines.push('# Code Review Report');
  lines.push('');

  // Quality score
  const scoreEmoji = overallScore >= 80 ? 'A' : overallScore >= 60 ? 'B' : overallScore >= 40 ? 'C' : 'D';
  lines.push(`## Quality Score: ${overallScore}/100 (${scoreEmoji})`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Files reviewed | ${diffResults.length} |`);
  lines.push(`| Total issues | ${totalIssues} |`);
  lines.push(`| Errors | ${errorCount} |`);
  lines.push(`| Warnings | ${warningCount} |`);
  lines.push(`| Info | ${infoCount} |`);
  lines.push('');

  // Per-file issues
  if (diffResults.some((r) => r.issues.length > 0)) {
    lines.push('## Issues by File');
    lines.push('');

    for (const result of diffResults) {
      if (result.issues.length === 0) continue;

      lines.push(`### ${result.file} (score: ${result.score}/100)`);
      lines.push('');

      for (const issue of result.issues) {
        const severity = issue.severity.toUpperCase();
        const rule = issue.rule ? ` [${issue.rule}]` : '';
        lines.push(`- **${severity}**${rule}: ${issue.message}`);
      }
      lines.push('');
    }
  }

  // Convention violations
  if (conventionResult && conventionResult.violations.length > 0) {
    lines.push('## Convention Violations');
    lines.push('');

    for (const violation of conventionResult.violations) {
      const severity = violation.severity.toUpperCase();
      lines.push(`- **${severity}** [${violation.ruleId}] ${violation.message} (${violation.filePath})`);
    }
    lines.push('');
  }

  // No issues
  if (totalIssues === 0) {
    lines.push('No issues found. Code looks good!');
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
    overallScore,
    totalIssues,
    errorCount,
    warningCount,
    infoCount,
  };
}
