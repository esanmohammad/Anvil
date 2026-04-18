// deploy up — spin up a sandbox environment

import type { DeployConfig, DeployResult } from './deploy-types.js';
import { DEFAULT_DEPLOY_CONFIG } from './deploy-types.js';
import { parseDeployOutput } from './deploy-output-parser.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ExecCommand = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecCommand: ExecCommand = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: opts?.timeout ?? 5 * 60_000,
  });
  return { stdout, stderr };
};

/**
 * Spin up a sandbox environment.
 */
export async function deployUp(
  project: string,
  config: Partial<DeployConfig> = {},
  execCommand: ExecCommand = defaultExecCommand,
): Promise<DeployResult> {
  const cfg: DeployConfig = { ...DEFAULT_DEPLOY_CONFIG, ...config };
  const args = ['up', project];
  if (cfg.remote) {
    args.push('--remote');
  }

  try {
    const { stdout, stderr } = await execCommand(cfg.command, args, {
      timeout: cfg.timeout,
    });
    const rawOutput = stdout + '\n' + stderr;
    const env = parseDeployOutput(rawOutput);

    if (!env) {
      return {
        success: false,
        rawOutput,
        error: {
          code: 'PARSE_ERROR',
          message: 'Could not parse deploy output',
          retriable: true,
        },
      };
    }

    return {
      success: true,
      environment: env,
      rawOutput,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('TIMEOUT') || message.includes('timed out');
    return {
      success: false,
      rawOutput: message,
      error: {
        code: isTimeout ? 'TIMEOUT' : 'EXEC_ERROR',
        message,
        retriable: isTimeout,
      },
    };
  }
}
