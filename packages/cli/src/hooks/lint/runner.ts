// Section C — Linter Runner
import { Language } from '../lang/detect.js';
import { parseGolangciLint, parseEslint, parseRuff } from './parsers.js';
import type { LintIssue } from './parsers.js';

export interface LintResult {
  success: boolean;
  filePath: string;
  issues: LintIssue[];
  error?: string;
}

export interface ExecFn {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

function buildFixArgs(linter: string, filePath: string): string[] {
  switch (linter) {
    case 'golangci-lint':
      return ['run', '--fix', filePath];
    case 'eslint':
      return ['--fix', '--format', 'json', filePath];
    case 'ruff':
      return ['check', '--fix', filePath];
    default:
      return [filePath];
  }
}

function buildCheckArgs(linter: string, filePath: string): string[] {
  switch (linter) {
    case 'golangci-lint':
      return ['run', filePath];
    case 'eslint':
      return ['--format', 'json', filePath];
    case 'ruff':
      return ['check', filePath];
    default:
      return [filePath];
  }
}

function parseLintOutput(linter: string, output: string): LintIssue[] {
  switch (linter) {
    case 'golangci-lint':
      return parseGolangciLint(output);
    case 'eslint':
      return parseEslint(output);
    case 'ruff':
      return parseRuff(output);
    default:
      return [];
  }
}

/**
 * Run a linter with auto-fix first, then a check pass to report remaining issues.
 */
export async function runLinter(
  linter: string,
  filePath: string,
  language: Language,
  exec: ExecFn,
): Promise<LintResult> {
  try {
    // Auto-fix pass (best effort, ignore errors)
    try {
      await exec(linter, buildFixArgs(linter, filePath));
    } catch {
      // Fix pass failure is non-fatal
    }

    // Check pass
    let stdout = '';
    try {
      const result = await exec(linter, buildCheckArgs(linter, filePath));
      stdout = result.stdout;
    } catch (err: unknown) {
      // Linters often exit with non-zero when issues found
      if (err && typeof err === 'object' && 'stdout' in err) {
        stdout = String((err as { stdout: string }).stdout);
      }
    }

    const issues = parseLintOutput(linter, stdout);
    return {
      success: issues.filter((i) => i.severity === 'error').length === 0,
      filePath,
      issues,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, filePath, issues: [], error: message };
  }
}
