// Section A — Binary Check
import { execFile } from 'node:child_process';

export interface ExecFn {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

/**
 * Check whether a binary exists on PATH by running `which <binary>`.
 */
export async function checkBinary(
  binary: string,
  exec: ExecFn = defaultExec,
): Promise<boolean> {
  try {
    await exec('which', [binary]);
    return true;
  } catch {
    return false;
  }
}
