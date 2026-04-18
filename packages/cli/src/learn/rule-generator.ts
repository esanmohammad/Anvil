// Rule generator — Wave 9, Section E
// Synthesizes detected patterns into convention rules

import type { ConventionRule } from '../conventions/rules/types.js';
import type { CiConfig } from './ci-scanner.js';
import type { TestPattern } from './test-scanner.js';
import type { RunPattern } from './run-analyzer.js';

export interface RuleGeneratorInput {
  ciConfigs?: CiConfig[];
  testPatterns?: TestPattern[];
  runPatterns?: RunPattern[];
  language?: string;
}

/**
 * Generate convention rules from detected patterns.
 */
export function generateRules(input: RuleGeneratorInput): ConventionRule[] {
  const rules: ConventionRule[] = [];
  let ruleIndex = 0;

  const lang = input.language ?? 'typescript';

  // Rules from test patterns
  if (input.testPatterns) {
    for (const tp of input.testPatterns) {
      if (tp.framework === 'jest' && tp.testFileSuffix) {
        rules.push({
          id: `gen-test-suffix-${ruleIndex++}`,
          name: 'Test file suffix convention',
          description: `Test files should use ${tp.testFileSuffix} suffix`,
          severity: 'warning',
          filePattern: `*.{ts,js,tsx,jsx}`,
          message: `Test files should use the ${tp.testFileSuffix} suffix to match project conventions.`,
          enabled: true,
        });
      }

      if (tp.usesMocking) {
        rules.push({
          id: `gen-mock-pattern-${ruleIndex++}`,
          name: 'Mocking pattern',
          description: 'Tests use mocking — ensure mocks are properly cleaned up',
          severity: 'info',
          filePattern: tp.testFileSuffix || '*.test.ts',
          message: 'Test uses mocking. Ensure afterEach/afterAll cleanup is present.',
          enabled: true,
        });
      }
    }
  }

  // Rules from CI configs
  if (input.ciConfigs) {
    for (const ci of input.ciConfigs) {
      if (ci.testCommands.length > 0) {
        rules.push({
          id: `gen-ci-test-${ruleIndex++}`,
          name: 'CI test command presence',
          description: `CI runs tests via: ${ci.testCommands[0]}`,
          severity: 'info',
          filePattern: '*',
          message: `Ensure tests pass with: ${ci.testCommands[0]}`,
          enabled: true,
        });
      }
    }
  }

  // Rules from run patterns
  if (input.runPatterns) {
    for (const rp of input.runPatterns) {
      if (rp.type === 'frequent-failure') {
        rules.push({
          id: `gen-failure-${ruleIndex++}`,
          name: `Frequent failure pattern: ${rp.description}`,
          description: rp.recommendation,
          severity: 'warning',
          filePattern: '*',
          message: rp.recommendation,
          enabled: true,
        });
      }
    }
  }

  // Language-specific defaults
  if (lang === 'typescript' || lang === 'javascript') {
    rules.push({
      id: `gen-no-any-${ruleIndex++}`,
      name: 'Avoid any type',
      description: 'Prefer explicit types over any',
      severity: 'warning',
      filePattern: '*.{ts,tsx}',
      deny: ':\\s*any\\b',
      message: 'Avoid using `any` type — prefer explicit types.',
      enabled: true,
    });
  }

  if (lang === 'go') {
    rules.push({
      id: `gen-error-handling-${ruleIndex++}`,
      name: 'Check error returns',
      description: 'Go functions should check error returns',
      severity: 'error',
      filePattern: '*.go',
      deny: '_\\s*=\\s*\\w+\\([^)]*\\)',
      message: 'Do not discard error returns. Handle or explicitly ignore with a comment.',
      enabled: true,
    });
  }

  return rules;
}
