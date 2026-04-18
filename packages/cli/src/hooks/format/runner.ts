// Section B — Formatter Runner
import { execFile } from 'node:child_process';
import { Language } from '../lang/detect.js';

export interface FormatResult {
  success: boolean;
  filePath: string;
  changed: boolean;
  error?: string;
}

export interface ExecFn {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

function buildFormatterArgs(formatter: string, filePath: string, language: Language): string[] {
  switch (formatter) {
    case 'gofmt':
      return ['-w', filePath];
    case 'prettier':
      return ['--write', filePath];
    case 'black':
      return [filePath];
    default:
      return [filePath];
  }
}

/**
 * Run a formatter binary on a file.
 */
export async function runFormatter(
  formatter: string,
  filePath: string,
  language: Language,
  exec: ExecFn = defaultExec,
): Promise<FormatResult> {
  const args = buildFormatterArgs(formatter, filePath, language);
  try {
    await exec(formatter, args);
    return { success: true, filePath, changed: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, filePath, changed: false, error: message };
  }
}
