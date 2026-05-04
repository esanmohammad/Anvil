// Rule loader — Section E.2

import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYAML } from 'yaml';
import type { RuleSet, ConventionRule, RuleSeverity } from './types.js';

const VALID_SEVERITIES: RuleSeverity[] = ['error', 'warning', 'info'];

function validateRule(raw: Record<string, unknown>, index: number): ConventionRule | null {
  const id = raw.id as string;
  if (!id || typeof id !== 'string') return null;

  const name = (raw.name as string) ?? id;
  const description = (raw.description as string) ?? '';
  const severity = VALID_SEVERITIES.includes(raw.severity as RuleSeverity)
    ? (raw.severity as RuleSeverity)
    : 'warning';
  const filePattern = (raw.filePattern as string) ?? '*';
  const message = (raw.message as string) ?? `Rule ${id} violated`;
  const enabled = raw.enabled !== false;

  // Validate regex patterns (compile to check they're valid)
  const deny = validateRegex(raw.deny as string | undefined);
  const require = validateRegex(raw.require as string | undefined);
  const trigger = validateRegex(raw.trigger as string | undefined);

  return {
    id,
    name,
    description,
    severity,
    filePattern,
    deny,
    require,
    trigger,
    message,
    enabled,
  };
}

function validateRegex(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  try {
    new RegExp(pattern);
    return pattern;
  } catch {
    return undefined;
  }
}

/**
 * Load rules from a YAML file. Validates fields and compiles regexes.
 */
export function loadRules(path: string): RuleSet {
  if (!existsSync(path)) {
    throw new Error(`Rules file not found: ${path}`);
  }

  const content = readFileSync(path, 'utf-8');
  const raw = parseYAML(content) as Record<string, unknown>;

  const name = (raw.name as string) ?? 'unnamed';
  const language = (raw.language as string) ?? 'unknown';
  const version = (raw.version as string) ?? '1.0.0';
  const rawRules = (raw.rules as Record<string, unknown>[]) ?? [];

  const rules: ConventionRule[] = [];
  for (let i = 0; i < rawRules.length; i++) {
    const rule = validateRule(rawRules[i], i);
    if (rule) rules.push(rule);
  }

  return { name, language, version, rules };
}
