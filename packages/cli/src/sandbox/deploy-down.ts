// deploy down — tear down a sandbox environment

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_DEPLOY_CONFIG } from './deploy-types.js';

const execFileAsync = promisify(execFile);

export type ExecCommand = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecCommand: ExecCommand = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 2 * 60_000,
  });
  return { stdout, stderr };
};

export interface DeployDownResult {
  success: boolean;
  retried: boolean;
  error?: string;
}

/**
 * Tear down a sandbox by namespace. Retries once on failure.
 */
export async function deployDown(
  namespace: string,
  execCommand: ExecCommand = defaultExecCommand,
  deployCommand: string = DEFAULT_DEPLOY_CONFIG.command,
): Promise<DeployDownResult> {
  try {
    await execCommand(deployCommand, ['down', namespace]);
    return { success: true, retried: false };
  } catch (firstError) {
    // Retry once
    try {
      await execCommand(deployCommand, ['down', namespace]);
      return { success: true, retried: true };
    } catch (retryError) {
      return {
        success: false,
        retried: true,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      };
    }
  }
}
