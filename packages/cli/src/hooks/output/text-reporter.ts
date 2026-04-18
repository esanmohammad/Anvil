// Section J — Text Reporter for terminal display
import pc from 'picocolors';
import type { CheckResult } from '../commands/check.js';
import { formatViolations } from '../convention/formatter.js';

export class TextReporter {
  format(result: CheckResult): string {
    const lines: string[] = [];

    // Format section
    lines.push(pc.bold('=== Format ==='));
    for (const r of result.formatResults) {
      if (r.success) {
        lines.push(`  ${pc.green('PASS')} ${r.filePath}${r.changed ? ' (formatted)' : ''}`);
      } else {
        lines.push(`  ${pc.red('FAIL')} ${r.filePath} — ${r.error ?? 'unknown error'}`);
      }
    }
    lines.push('');

    // Lint section
    lines.push(pc.bold('=== Lint ==='));
    for (const r of result.lintResults) {
      if (r.success) {
        lines.push(`  ${pc.green('PASS')} ${r.filePath}`);
      } else {
        lines.push(`  ${pc.red('FAIL')} ${r.filePath} — ${r.issues.length} issue(s)`);
        for (const issue of r.issues) {
          const sev = issue.severity === 'error' ? pc.red('E') : pc.yellow('W');
          lines.push(`    [${sev}] ${issue.line}:${issue.column} ${issue.message}`);
        }
      }
    }
    lines.push('');

    // Convention section
    lines.push(pc.bold('=== Conventions ==='));
    lines.push(formatViolations(result.conventionViolations));
    lines.push('');

    // Summary
    if (result.passed) {
      lines.push(pc.green(pc.bold('All checks passed.')));
    } else {
      lines.push(pc.red(pc.bold('Some checks failed.')));
    }

    return lines.join('\n');
  }
}
