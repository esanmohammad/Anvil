// Diff reviewer — Wave 9, Section B
// Analyzes a git diff against coding conventions

export interface DiffFile {
  path: string;
  additions: string[];
  deletions: string[];
  hunks: number;
}

export interface DiffReviewResult {
  file: string;
  issues: DiffIssue[];
  score: number; // 0-100
}

export interface DiffIssue {
  line: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  rule?: string;
}

/**
 * Parse a unified diff string into structured DiffFile objects.
 */
export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileChunks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const headerMatch = chunk.match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const path = headerMatch[2];
    const additions: string[] = [];
    const deletions: string[] = [];
    let hunks = 0;

    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('@@')) {
        hunks++;
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        additions.push(line.slice(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions.push(line.slice(1));
      }
    }

    files.push({ path, additions, deletions, hunks });
  }

  return files;
}

/**
 * Review a diff for common code quality issues.
 * Returns per-file review results with a quality score.
 */
export function reviewDiff(diffText: string): DiffReviewResult[] {
  const files = parseDiff(diffText);
  const results: DiffReviewResult[] = [];

  for (const file of files) {
    const issues: DiffIssue[] = [];

    for (const line of file.additions) {
      // Check for console.log statements
      if (/console\.(log|debug|info)\(/.test(line)) {
        issues.push({
          line,
          severity: 'warning',
          message: 'Avoid console.log in production code — use a proper logger',
          rule: 'no-console-log',
        });
      }

      // Check for TODO/FIXME without ticket
      if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line) && !/[A-Z]+-\d+/.test(line)) {
        issues.push({
          line,
          severity: 'info',
          message: 'TODO/FIXME comment without a ticket reference',
          rule: 'todo-needs-ticket',
        });
      }

      // Check for hardcoded secrets patterns
      if (/(?:password|secret|token|api_key)\s*[:=]\s*['"][^'"]+['"]/i.test(line)) {
        issues.push({
          line,
          severity: 'error',
          message: 'Possible hardcoded secret detected',
          rule: 'no-hardcoded-secrets',
        });
      }

      // Check for large functions (many additions in one hunk)
      if (/any\b/.test(line) && /:\s*any\b/.test(line)) {
        issues.push({
          line,
          severity: 'warning',
          message: 'Avoid using `any` type — prefer explicit types',
          rule: 'no-explicit-any',
        });
      }
    }

    // Score: start at 100, deduct for issues
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;
    const infoCount = issues.filter((i) => i.severity === 'info').length;
    const score = Math.max(0, 100 - errorCount * 20 - warningCount * 5 - infoCount * 1);

    results.push({ file: file.path, issues, score });
  }

  return results;
}
