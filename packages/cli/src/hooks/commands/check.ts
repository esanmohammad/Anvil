// Section H — ff-hook check command (full pipeline: format → lint → convention)
import { Command } from 'commander';
import { runFormatCommand } from './format.js';
import { runLintCommand } from './lint.js';
import { runConventionCommand } from './convention.js';
import type { FormatCommandDeps } from './format.js';
import type { LintCommandDeps } from './lint.js';
import type { ConventionCommandDeps } from './convention.js';
import type { FormatResult } from '../format/runner.js';
import type { LintResult } from '../lint/runner.js';
import type { ConventionViolation } from '../convention/types.js';

export interface CheckResult {
  formatResults: FormatResult[];
  lintResults: LintResult[];
  conventionViolations: ConventionViolation[];
  passed: boolean;
}

export interface CheckCommandDeps {
  runFormatCommand: typeof runFormatCommand;
  runLintCommand: typeof runLintCommand;
  runConventionCommand: typeof runConventionCommand;
  formatDeps?: FormatCommandDeps;
  lintDeps?: LintCommandDeps;
  conventionDeps?: ConventionCommandDeps;
  rulesPath: string;
}

/**
 * Run the full check pipeline: format → lint → convention.
 */
export async function runCheckCommand(
  files: string[],
  deps: CheckCommandDeps,
): Promise<CheckResult> {
  // Step 1: Format
  const formatResults = await deps.runFormatCommand(files, deps.formatDeps);
  const formatPassed = formatResults.every((r) => r.success);

  // Step 2: Lint
  const lintResults = await deps.runLintCommand(files, deps.lintDeps);
  const lintPassed = lintResults.every((r) => r.success);

  // Step 3: Convention check
  let conventionViolations: ConventionViolation[] = [];
  if (deps.conventionDeps) {
    conventionViolations = await deps.runConventionCommand(
      files,
      deps.rulesPath,
      deps.conventionDeps,
    );
  }
  const conventionPassed = conventionViolations.filter((v) => v.level === 'error').length === 0;

  return {
    formatResults,
    lintResults,
    conventionViolations,
    passed: formatPassed && lintPassed && conventionPassed,
  };
}

export const checkCommand = new Command('check')
  .description('Run full pipeline: format → lint → convention')
  .option('--rules <path>', 'Path to convention rules YAML', '.anvil/conventions.yaml')
  .argument('<files...>', 'Files to check')
  .action(async (files: string[], opts: { rules: string }) => {
    const result = await runCheckCommand(files, {
      runFormatCommand,
      runLintCommand,
      runConventionCommand,
      rulesPath: opts.rules,
    });

    if (!result.passed) {
      process.exitCode = 1;
    }
  });
