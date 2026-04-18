// Section C — ff-hook lint command
import { Command } from 'commander';
import { detectLanguage } from '../lang/detect.js';
import { resolveTools } from '../lang/tools.js';
import { checkBinary } from '../lang/binary-check.js';
import { runLinter } from '../lint/runner.js';
import type { LintResult } from '../lint/runner.js';
import type { ExecFn } from '../lint/runner.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args);
  return { stdout, stderr };
};

export interface LintCommandDeps {
  detectLanguage: typeof detectLanguage;
  resolveTools: typeof resolveTools;
  checkBinary: typeof checkBinary;
  runLinter: typeof runLinter;
  log: (msg: string) => void;
}

const defaultDeps: LintCommandDeps = {
  detectLanguage,
  resolveTools,
  checkBinary,
  runLinter,
  log: console.log,
};

export async function runLintCommand(
  files: string[],
  deps: LintCommandDeps = defaultDeps,
): Promise<LintResult[]> {
  const results: LintResult[] = [];

  for (const file of files) {
    const lang = deps.detectLanguage(file);
    const tools = deps.resolveTools(lang);

    if (!tools.linter) {
      results.push({ success: true, filePath: file, issues: [] });
      continue;
    }

    const exists = await deps.checkBinary(tools.linter);
    if (!exists) {
      results.push({
        success: false,
        filePath: file,
        issues: [],
        error: `Linter '${tools.linter}' not found on PATH`,
      });
      continue;
    }

    const result = await deps.runLinter(tools.linter, file, lang, defaultExec);
    results.push(result);
  }

  return results;
}

export const lintCommand = new Command('lint')
  .description('Run linter on specified files')
  .argument('<files...>', 'Files to lint')
  .action(async (files: string[]) => {
    const results = await runLintCommand(files);
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      for (const f of failures) {
        console.error(`FAIL: ${f.filePath} — ${f.error ?? `${f.issues.length} issue(s)`}`);
      }
      process.exitCode = 1;
    }
  });
