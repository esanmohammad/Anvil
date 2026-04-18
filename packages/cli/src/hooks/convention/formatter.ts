// Section G — Convention Violation Formatter
import pc from 'picocolors';
import type { ConventionViolation, EnforcementLevel } from './types.js';

function levelColor(level: EnforcementLevel): (text: string) => string {
  switch (level) {
    case 'error':
      return pc.red;
    case 'warning':
      return pc.yellow;
    case 'info':
      return pc.cyan;
    default:
      return pc.dim;
  }
}

function levelIcon(level: EnforcementLevel): string {
  switch (level) {
    case 'error':
      return 'x';
    case 'warning':
      return '!';
    case 'info':
      return 'i';
    default:
      return '-';
  }
}

/**
 * Format a single violation with color-coded output.
 */
export function formatViolation(violation: ConventionViolation): string {
  const color = levelColor(violation.level);
  const icon = levelIcon(violation.level);
  const location = violation.line
    ? `${violation.filePath}:${violation.line}`
    : violation.filePath;

  const parts = [
    color(`[${icon}]`),
    pc.bold(violation.ruleName),
    pc.dim(location),
    violation.message,
  ];

  if (violation.matchedText) {
    parts.push(pc.dim(`(matched: ${violation.matchedText})`));
  }

  return parts.join(' ');
}

/**
 * Format multiple violations grouped by file.
 */
export function formatViolations(violations: ConventionViolation[]): string {
  if (violations.length === 0) {
    return pc.green('No convention violations found.');
  }

  const byFile = new Map<string, ConventionViolation[]>();
  for (const v of violations) {
    const existing = byFile.get(v.filePath) ?? [];
    existing.push(v);
    byFile.set(v.filePath, existing);
  }

  const lines: string[] = [];
  for (const [file, fileViolations] of byFile) {
    lines.push(pc.underline(file));
    for (const v of fileViolations) {
      lines.push(`  ${formatViolation(v)}`);
    }
    lines.push('');
  }

  const errorCount = violations.filter((v) => v.level === 'error').length;
  const warnCount = violations.filter((v) => v.level === 'warning').length;
  lines.push(
    `${pc.red(`${errorCount} error(s)`)} ${pc.yellow(`${warnCount} warning(s)`)} in ${byFile.size} file(s)`,
  );

  return lines.join('\n');
}
