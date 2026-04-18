// Convention enforcement engine — checks pipeline outputs against project rules

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';

export interface ConventionRule {
  id: string;
  name: string;
  severity: 'error' | 'warning' | 'info';
  description: string;
  pattern?: string;     // regex pattern to match violations
  check?: string;       // shell command that returns 0 if passing
}

export interface ConventionViolation {
  ruleId: string;
  ruleName: string;
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  message: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Extracts key: value pairs between --- delimiters.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  const lines = match[1].split('\n');

  for (const line of lines) {
    const kvMatch = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
    if (kvMatch) {
      result[kvMatch[1].trim()] = kvMatch[2].trim();
    }
  }

  return result;
}

/**
 * Parse a factory.yaml-style file for domain.invariants using regex-based YAML parsing.
 */
function parseInvariantsFromFactoryYaml(content: string): Array<{ id: string; statement: string }> {
  const invariants: Array<{ id: string; statement: string }> = [];

  // Match invariants section: look for lines under "invariants:" key
  const invariantsMatch = content.match(/^[ \t]*invariants:\s*\n((?:[ \t]+- [\s\S]*?)(?=\n\S|\n*$))/m);
  if (!invariantsMatch) return invariants;

  const block = invariantsMatch[1];
  // Match each list item with id and statement fields
  const itemPattern = /- +id:\s*(.+)\n\s+statement:\s*(.+)/g;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(block)) !== null) {
    invariants.push({
      id: match[1].trim().replace(/^["']|["']$/g, ''),
      statement: match[2].trim().replace(/^["']|["']$/g, ''),
    });
  }

  return invariants;
}

/**
 * Load convention rules from ~/.anvil/conventions/rules/ and factory.yaml domain.invariants.
 */
export function loadConventionRules(project: string): ConventionRule[] {
  const rules: ConventionRule[] = [];
  const anvilHome = join(homedir(), '.anvil');

  // 1. Load rules from markdown files in ~/.anvil/conventions/rules/
  const rulesDir = join(anvilHome, 'conventions', 'rules');
  if (existsSync(rulesDir)) {
    const files = readdirSync(rulesDir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = readFileSync(join(rulesDir, file), 'utf-8');
        const frontmatter = parseFrontmatter(content);

        if (frontmatter.id) {
          rules.push({
            id: frontmatter.id,
            name: frontmatter.name || frontmatter.id,
            severity: (['error', 'warning', 'info'].includes(frontmatter.severity)
              ? frontmatter.severity
              : 'warning') as ConventionRule['severity'],
            description: frontmatter.description || '',
            pattern: frontmatter.pattern || undefined,
            check: frontmatter.check || undefined,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Also check project-specific rules directory
  const projectRulesDir = join(rulesDir, project);
  if (existsSync(projectRulesDir)) {
    const files = readdirSync(projectRulesDir).filter((f) => f.endsWith('.md') || f.endsWith('.json'));

    for (const file of files) {
      try {
        if (file.endsWith('.json')) {
          const content = readFileSync(join(projectRulesDir, file), 'utf-8');
          const parsed = JSON.parse(content);
          const jsonRules = parsed.rules ?? [];
          for (const r of jsonRules) {
            if (r.id) {
              rules.push({
                id: r.id,
                name: r.name || r.id,
                severity: r.severity || 'warning',
                description: r.description || r.message || '',
                pattern: r.deny || r.trigger || undefined,
              });
            }
          }
        } else {
          const content = readFileSync(join(projectRulesDir, file), 'utf-8');
          const frontmatter = parseFrontmatter(content);
          if (frontmatter.id) {
            rules.push({
              id: frontmatter.id,
              name: frontmatter.name || frontmatter.id,
              severity: (['error', 'warning', 'info'].includes(frontmatter.severity)
                ? frontmatter.severity
                : 'warning') as ConventionRule['severity'],
              description: frontmatter.description || '',
              pattern: frontmatter.pattern || undefined,
              check: frontmatter.check || undefined,
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // 2. Load invariants from factory.yaml (project-level or project-level)
  const factoryYamlPaths = [
    join(anvilHome, 'projects', project, 'project.yaml'),
    'factory.yaml',
    join(process.cwd(), 'factory.yaml'),
  ];

  for (const yamlPath of factoryYamlPaths) {
    if (existsSync(yamlPath)) {
      try {
        const content = readFileSync(yamlPath, 'utf-8');
        const invariants = parseInvariantsFromFactoryYaml(content);

        for (const inv of invariants) {
          rules.push({
            id: `invariant-${inv.id}`,
            name: `Invariant: ${inv.id}`,
            severity: 'error',
            description: inv.statement,
          });
        }
      } catch {
        // Skip unreadable factory.yaml
      }
      break; // Only use the first found
    }
  }

  return rules;
}

/**
 * Check pipeline output or code changes against loaded convention rules.
 */
export function checkConventions(
  rules: ConventionRule[],
  content: string,
  context?: { files?: string[]; repoPath?: string },
): ConventionViolation[] {
  const violations: ConventionViolation[] = [];

  for (const rule of rules) {
    // Pattern-based rules: test regex against content
    if (rule.pattern) {
      try {
        const regex = new RegExp(rule.pattern, 'gm');
        let match: RegExpExecArray | null;

        while ((match = regex.exec(content)) !== null) {
          // Calculate line number from match index
          const beforeMatch = content.slice(0, match.index);
          const line = beforeMatch.split('\n').length;

          violations.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            line,
            message: rule.description || `Pattern violation: ${rule.pattern}`,
          });
        }
      } catch {
        // Invalid regex, skip rule
      }
    }

    // Invariant rules (no pattern): do keyword presence checking
    if (!rule.pattern && !rule.check && rule.id.startsWith('invariant-')) {
      // Extract key terms from the invariant statement
      const keywords = rule.description
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .filter((w) => !['should', 'must', 'always', 'never', 'every', 'ensure', 'shall'].includes(w));

      // Check if any content contradicts the invariant (heuristic: presence of negation + keyword)
      const contentLower = content.toLowerCase();
      for (const keyword of keywords) {
        const negationPatterns = [
          `not ${keyword}`,
          `no ${keyword}`,
          `without ${keyword}`,
          `skip ${keyword}`,
          `disable ${keyword}`,
          `remove ${keyword}`,
        ];

        for (const neg of negationPatterns) {
          if (contentLower.includes(neg)) {
            violations.push({
              ruleId: rule.id,
              ruleName: rule.name,
              severity: rule.severity,
              message: `Possible invariant violation: "${rule.description}" — found "${neg}" in content`,
            });
            break;
          }
        }
      }
    }
  }

  // Sort by severity: error first, then warning, then info
  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  violations.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

  return violations;
}

/**
 * Format violations for terminal output.
 */
export function formatViolations(violations: ConventionViolation[]): string {
  if (violations.length === 0) {
    return pc.green('No convention violations found.');
  }

  const lines: string[] = [];

  for (const v of violations) {
    const icon =
      v.severity === 'error'
        ? pc.red('\u2717')
        : v.severity === 'warning'
          ? pc.yellow('\u26A0')
          : pc.blue('\u2139');

    const location = v.file
      ? `${v.file}${v.line ? `:${v.line}` : ''}`
      : v.line
        ? `line ${v.line}`
        : '';

    const locationStr = location ? pc.dim(` (${location})`) : '';

    lines.push(`  ${icon} ${pc.bold(v.ruleName)}${locationStr}`);
    lines.push(`    ${v.message}`);
  }

  // Summary
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warnCount = violations.filter((v) => v.severity === 'warning').length;
  const infoCount = violations.filter((v) => v.severity === 'info').length;

  const parts: string[] = [];
  if (errorCount > 0) parts.push(pc.red(`${errorCount} error(s)`));
  if (warnCount > 0) parts.push(pc.yellow(`${warnCount} warning(s)`));
  if (infoCount > 0) parts.push(pc.blue(`${infoCount} info`));

  lines.push('');
  lines.push(`  ${parts.join(', ')} — ${violations.length} total violation(s)`);

  return lines.join('\n');
}
