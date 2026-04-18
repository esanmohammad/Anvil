// Section B — ff-hook format command
import { Command } from 'commander';
import { detectLanguage } from '../lang/detect.js';
import { resolveTools } from '../lang/tools.js';
import { checkBinary } from '../lang/binary-check.js';
import { runFormatter } from '../format/runner.js';
import type { FormatResult } from '../format/runner.js';

export interface FormatCommandDeps {
  detectLanguage: typeof detectLanguage;
  resolveTools: typeof resolveTools;
  checkBinary: typeof checkBinary;
  runFormatter: typeof runFormatter;
  log: (msg: string) => void;
}

const defaultDeps: FormatCommandDeps = {
  detectLanguage,
  resolveTools,
  checkBinary,
  runFormatter,
  log: console.log,
};

export async function runFormatCommand(
  files: string[],
  deps: FormatCommandDeps = defaultDeps,
): Promise<FormatResult[]> {
  const results: FormatResult[] = [];

  for (const file of files) {
    const lang = deps.detectLanguage(file);
    const tools = deps.resolveTools(lang);

    if (!tools.formatter) {
      results.push({ success: true, filePath: file, changed: false });
      continue;
    }

    const exists = await deps.checkBinary(tools.formatter);
    if (!exists) {
      results.push({
        success: false,
        filePath: file,
        changed: false,
        error: `Formatter '${tools.formatter}' not found on PATH`,
      });
      continue;
    }

    const result = await deps.runFormatter(tools.formatter, file, lang);
    results.push(result);
  }

  return results;
}

export const formatCommand = new Command('format')
  .description('Run formatter on specified files')
  .argument('<files...>', 'Files to format')
  .action(async (files: string[]) => {
    const results = await runFormatCommand(files);
    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      for (const f of failures) {
        console.error(`FAIL: ${f.filePath} — ${f.error}`);
      }
      process.exitCode = 1;
    }
  });
