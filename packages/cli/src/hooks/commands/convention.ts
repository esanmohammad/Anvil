// Section G — ff-hook convention command
import { Command } from 'commander';
import { scanDiff } from '../diff/scanner.js';
import { loadConventionRules } from '../convention/loader.js';
import { loadEnforcementConfig, applyEnforcement } from '../convention/enforcement.js';
import { formatViolation } from '../convention/formatter.js';
import type { ConventionViolation } from '../convention/types.js';
import type { ScanResult } from '../diff/scanner.js';

export interface ConventionCommandDeps {
  loadConventionRules: typeof loadConventionRules;
  loadEnforcementConfig: typeof loadEnforcementConfig;
  applyEnforcement: typeof applyEnforcement;
  scanDiff: typeof scanDiff;
  formatViolation: typeof formatViolation;
  log: (msg: string) => void;
  getDiff: (file: string) => string;
}

export async function runConventionCommand(
  files: string[],
  rulesPath: string,
  deps: ConventionCommandDeps,
  options?: { project?: boolean },
): Promise<ConventionViolation[]> {
  const rawRules = deps.loadConventionRules(rulesPath);
  const enforcementConfig = deps.loadEnforcementConfig();
  const rules = deps.applyEnforcement(rawRules, enforcementConfig);

  const allViolations: ConventionViolation[] = [];

  for (const file of files) {
    const diffOutput = deps.getDiff(file);
    const result: ScanResult = deps.scanDiff({
      diffOutput,
      filePath: file,
      denyPatterns: rules.deny,
      requirePatterns: rules.require,
    });

    for (const dm of result.denyMatches) {
      const violation: ConventionViolation = {
        ruleName: dm.pattern.name,
        level: dm.pattern.level,
        message: dm.pattern.message ?? `Denied pattern matched: ${dm.matchedText}`,
        filePath: file,
        line: dm.line.newLineNumber,
        matchedText: dm.matchedText,
      };
      allViolations.push(violation);
      deps.log(deps.formatViolation(violation));
    }

    for (const rv of result.requireViolations) {
      const violation: ConventionViolation = {
        ruleName: rv.pattern.name,
        level: rv.pattern.level,
        message: rv.message,
        filePath: file,
      };
      allViolations.push(violation);
      deps.log(deps.formatViolation(violation));
    }
  }

  return allViolations;
}

export const conventionCommand = new Command('convention')
  .description('Check convention rules against file diffs')
  .option('--project', 'Include project-level convention rules')
  .option('--rules <path>', 'Path to convention rules YAML', '.anvil/conventions.yaml')
  .argument('<files...>', 'Files to check')
  .action(async (files: string[], opts: { project?: boolean; rules: string }) => {
    const { execSync } = await import('node:child_process');
    const violations = await runConventionCommand(
      files,
      opts.rules,
      {
        loadConventionRules,
        loadEnforcementConfig,
        applyEnforcement,
        scanDiff,
        formatViolation,
        log: console.log,
        getDiff: (file: string) => {
          try {
            return execSync(`git diff HEAD -- ${file}`, { encoding: 'utf-8' });
          } catch {
            return '';
          }
        },
      },
      { project: opts.project },
    );

    const errors = violations.filter((v) => v.level === 'error');
    if (errors.length > 0) {
      process.exitCode = 1;
    }
  });
