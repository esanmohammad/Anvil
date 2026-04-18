// Section E — Convention Rules Loader
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { ConventionRules, DenyPattern, RequirePattern, EnforcementLevel } from './types.js';

export interface ReadFileFn {
  (path: string, encoding: BufferEncoding): string;
}

/**
 * Load convention rules from a YAML file.
 */
export function loadConventionRules(
  filePath: string,
  readFile: ReadFileFn = (p, e) => readFileSync(p, e),
): ConventionRules {
  const content = readFile(filePath, 'utf-8');
  const doc = YAML.parse(content) as Record<string, unknown>;

  const deny: DenyPattern[] = [];
  const require: RequirePattern[] = [];

  if (Array.isArray(doc.deny)) {
    for (const item of doc.deny) {
      deny.push({
        name: String(item.name ?? 'unnamed'),
        pattern: String(item.pattern ?? ''),
        flags: item.flags ? String(item.flags) : undefined,
        message: item.message ? String(item.message) : undefined,
        level: (item.level as EnforcementLevel) ?? 'error',
      });
    }
  }

  if (Array.isArray(doc.require)) {
    for (const item of doc.require) {
      require.push({
        name: String(item.name ?? 'unnamed'),
        pattern: String(item.pattern ?? ''),
        flags: item.flags ? String(item.flags) : undefined,
        message: item.message ? String(item.message) : undefined,
        level: (item.level as EnforcementLevel) ?? 'warning',
        minLines: typeof item.minLines === 'number' ? item.minLines : undefined,
      });
    }
  }

  return {
    deny,
    require,
    filePatterns: Array.isArray(doc.filePatterns)
      ? doc.filePatterns.map(String)
      : ['**/*'],
    language: typeof doc.language === 'string' ? doc.language : undefined,
  };
}
