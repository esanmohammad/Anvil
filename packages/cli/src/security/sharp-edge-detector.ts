/**
 * SharpEdgeDetector — detect dangerous commands and patterns.
 */

export interface SharpEdgeFinding {
  type: 'destructive-command' | 'force-push' | 'hook-bypass' | 'env-overwrite' | 'sql-danger';
  pattern: string;
  line: number;
  snippet: string;
  severity: 'warning' | 'error';
}

interface EdgePattern {
  type: SharpEdgeFinding['type'];
  regex: RegExp;
  severity: SharpEdgeFinding['severity'];
  description: string;
}

const EDGE_PATTERNS: EdgePattern[] = [
  // rm -rf
  { type: 'destructive-command', regex: /\brm\s+-r?f\b/, severity: 'error', description: 'rm -rf command' },
  { type: 'destructive-command', regex: /\brm\s+-fr\b/, severity: 'error', description: 'rm -fr command' },
  // DROP TABLE
  { type: 'sql-danger', regex: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i, severity: 'error', description: 'DROP statement' },
  { type: 'sql-danger', regex: /\bTRUNCATE\s+TABLE\b/i, severity: 'error', description: 'TRUNCATE statement' },
  { type: 'sql-danger', regex: /\bDELETE\s+FROM\b.*\bWHERE\s+1\s*=\s*1/i, severity: 'error', description: 'DELETE with always-true condition' },
  // Force push
  { type: 'force-push', regex: /\bgit\s+push\s+.*--force\b/, severity: 'error', description: 'git push --force' },
  { type: 'force-push', regex: /\bgit\s+push\s+-f\b/, severity: 'error', description: 'git push -f' },
  // Hook bypass
  { type: 'hook-bypass', regex: /--no-verify\b/, severity: 'warning', description: '--no-verify flag' },
  { type: 'hook-bypass', regex: /--no-gpg-sign\b/, severity: 'warning', description: '--no-gpg-sign flag' },
  // Environment overwrites
  { type: 'env-overwrite', regex: /\bprocess\.env\.[A-Z_]+=/, severity: 'warning', description: 'process.env overwrite' },
  { type: 'env-overwrite', regex: /\bexport\s+[A-Z_]+=.*\$/, severity: 'warning', description: 'Shell env export' },
];

export class SharpEdgeDetector {
  private customPatterns: EdgePattern[] = [];

  /** Add a custom pattern. */
  addPattern(
    type: SharpEdgeFinding['type'],
    regex: RegExp,
    severity: SharpEdgeFinding['severity'] = 'error',
    description: string = 'Custom pattern',
  ): void {
    this.customPatterns.push({ type, regex, severity, description });
  }

  /** Scan content for sharp edges. */
  scan(content: string): SharpEdgeFinding[] {
    const findings: SharpEdgeFinding[] = [];
    const lines = content.split('\n');
    const allPatterns = [...EDGE_PATTERNS, ...this.customPatterns];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of allPatterns) {
        if (pattern.regex.test(line)) {
          findings.push({
            type: pattern.type,
            pattern: pattern.description,
            line: i + 1,
            snippet: line.trim(),
            severity: pattern.severity,
          });
        }
      }
    }

    return findings;
  }

  /** Quick check for any error-severity findings. */
  hasErrors(content: string): boolean {
    return this.scan(content).some((f) => f.severity === 'error');
  }
}
