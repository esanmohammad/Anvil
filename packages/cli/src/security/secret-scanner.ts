/**
 * SecretScanner — detect API keys, high-entropy strings, passwords, connection strings.
 */

export interface SecretFinding {
  type: 'api-key' | 'high-entropy' | 'password' | 'connection-string';
  pattern: string;
  line: number;
  snippet: string;
  severity: 'warning' | 'error';
}

interface PatternDef {
  type: SecretFinding['type'];
  regex: RegExp;
  severity: SecretFinding['severity'];
  description: string;
}

const SECRET_PATTERNS: PatternDef[] = [
  // AWS access key
  { type: 'api-key', regex: /AKIA[0-9A-Z]{16}/, severity: 'error', description: 'AWS access key' },
  // GitHub token
  { type: 'api-key', regex: /ghp_[A-Za-z0-9]{36}/, severity: 'error', description: 'GitHub personal access token' },
  // OpenAI/Anthropic key prefixes
  { type: 'api-key', regex: /sk-[A-Za-z0-9]{20,}/, severity: 'error', description: 'API key (sk- prefix)' },
  // Generic API key assignment
  { type: 'api-key', regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i, severity: 'error', description: 'API key assignment' },
  // Password assignments
  { type: 'password', regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i, severity: 'error', description: 'Password assignment' },
  // Connection strings
  { type: 'connection-string', regex: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]{10,}/i, severity: 'error', description: 'Connection string' },
  // Private keys
  { type: 'api-key', regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, severity: 'error', description: 'Private key' },
];

export class SecretScanner {
  private customPatterns: PatternDef[] = [];

  /** Add a custom pattern to scan for. */
  addPattern(
    type: SecretFinding['type'],
    regex: RegExp,
    severity: SecretFinding['severity'] = 'error',
    description: string = 'Custom pattern',
  ): void {
    this.customPatterns.push({ type, regex, severity, description });
  }

  /** Scan content for secrets. */
  scan(content: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const lines = content.split('\n');
    const allPatterns = [...SECRET_PATTERNS, ...this.customPatterns];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of allPatterns) {
        const match = pattern.regex.exec(line);
        if (match) {
          findings.push({
            type: pattern.type,
            pattern: pattern.description,
            line: i + 1,
            snippet: this.redactSnippet(line, match[0]),
            severity: pattern.severity,
          });
        }
      }

      // Check for high-entropy strings (potential secrets)
      const highEntropy = this.findHighEntropyStrings(line);
      if (highEntropy) {
        findings.push({
          type: 'high-entropy',
          pattern: 'High entropy string',
          line: i + 1,
          snippet: this.redactSnippet(line, highEntropy),
          severity: 'warning',
        });
      }
    }

    return findings;
  }

  /** Calculate Shannon entropy of a string. */
  private shannonEntropy(str: string): number {
    const freq = new Map<string, number>();
    for (const ch of str) {
      freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / str.length;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /** Find high-entropy strings in a line (potential secrets). */
  private findHighEntropyStrings(line: string): string | null {
    // Look for quoted strings that look like secrets
    const matches = line.match(/['"]([A-Za-z0-9+/=_-]{20,})['"]/);
    if (matches && matches[1]) {
      const str = matches[1];
      const entropy = this.shannonEntropy(str);
      // High entropy threshold (typically > 4.0 for random strings)
      if (entropy > 4.5 && str.length >= 20) {
        return str;
      }
    }
    return null;
  }

  /** Redact the middle of a sensitive value in the snippet. */
  private redactSnippet(line: string, secret: string): string {
    if (secret.length <= 8) return line.replace(secret, '***');
    const visible = secret.slice(0, 4) + '...' + secret.slice(-4);
    return line.replace(secret, visible);
  }
}
