// Rule evaluation engine — Section E.5

import type { ConventionRule, RuleViolation } from './types.js';

/**
 * Check if a file path matches a glob-like pattern.
 * Supports simple patterns like *.ts, *.{ts,go}
 */
function matchesFilePattern(filePath: string, pattern: string): boolean {
  // Handle {ts,go} patterns
  const expanded = pattern.replace(/\{([^}]+)\}/g, (_match, group: string) => {
    const alts = group.split(',').map((a: string) => a.trim());
    return `(${alts.join('|')})`;
  });

  // Convert glob to regex
  const regexStr = expanded
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  try {
    const regex = new RegExp(regexStr + '$');
    return regex.test(filePath);
  } catch {
    return false;
  }
}

/**
 * Evaluate rules against a file's content.
 * Returns any violations found.
 */
export function evaluateRules(
  rules: ConventionRule[],
  filePath: string,
  content: string,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const lines = content.split('\n');

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesFilePattern(filePath, rule.filePattern)) continue;

    // Deny pattern: should NOT appear
    if (rule.deny) {
      try {
        const regex = new RegExp(rule.deny, 'g');
        for (let i = 0; i < lines.length; i++) {
          const match = regex.exec(lines[i]);
          if (match) {
            violations.push({
              ruleId: rule.id,
              ruleName: rule.name,
              severity: rule.severity,
              message: rule.message,
              filePath,
              line: i + 1,
              matchedText: match[0],
            });
          }
          regex.lastIndex = 0;
        }
      } catch {
        // Invalid regex, skip
      }
    }

    // Require pattern: MUST appear somewhere in the file
    if (rule.require) {
      try {
        const regex = new RegExp(rule.require);
        if (!regex.test(content)) {
          violations.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            message: rule.message,
            filePath,
          });
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  return violations;
}
