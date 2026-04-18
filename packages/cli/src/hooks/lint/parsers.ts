// Section C — Lint output parsers

export interface LintIssue {
  filePath: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  rule?: string;
}

/**
 * Parse golangci-lint output (line format: file:line:col: message (linter-name))
 */
export function parseGolangciLint(output: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const match = line.match(/^(.+):(\d+):(\d+):\s*(.+?)(?:\s*\((\w[\w-]*)\))?$/);
    if (match) {
      issues.push({
        filePath: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: 'error',
        message: match[4].trim(),
        rule: match[5] || undefined,
      });
    }
  }

  return issues;
}

/**
 * Parse ESLint output (JSON format expected from --format json).
 */
export function parseEslint(output: string): LintIssue[] {
  const issues: LintIssue[] = [];
  try {
    const results = JSON.parse(output) as Array<{
      filePath: string;
      messages: Array<{
        line: number;
        column: number;
        severity: number;
        message: string;
        ruleId: string | null;
      }>;
    }>;

    for (const result of results) {
      for (const msg of result.messages) {
        issues.push({
          filePath: result.filePath,
          line: msg.line,
          column: msg.column,
          severity: msg.severity === 2 ? 'error' : 'warning',
          message: msg.message,
          rule: msg.ruleId ?? undefined,
        });
      }
    }
  } catch {
    // If JSON parsing fails, return empty
  }

  return issues;
}

/**
 * Parse Ruff output (line format: file:line:col: CODE message)
 */
export function parseRuff(output: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = output.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const match = line.match(/^(.+):(\d+):(\d+):\s*([A-Z]\d+)\s+(.+)$/);
    if (match) {
      issues.push({
        filePath: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: 'error',
        message: match[5].trim(),
        rule: match[4],
      });
    }
  }

  return issues;
}
