import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SandboxResult {
  url: string;
  status: 'ready' | 'failed';
  error?: string;
}

type ExecCommand = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExecCommand: ExecCommand = async (cmd, args) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  return { stdout, stderr };
};

/**
 * Deploys a sandbox by running the deploy command for <project>.
 * Parses the URL from the command output.
 */
export async function deploySandbox(
  project: string,
  runId: string,
  execCommand: ExecCommand = defaultExecCommand,
): Promise<SandboxResult> {
  try {
    const deployCmd = process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD || 'anvil';
    const { stdout, stderr } = await execCommand(deployCmd, ['up', project, '--remote']);
    const output = stdout + '\n' + stderr;

    // Parse URL from output — look for http(s)://...
    const urlMatch = output.match(/https?:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : '';

    if (!url) {
      return {
        url: '',
        status: 'failed',
        error: 'Could not parse sandbox URL from output',
      };
    }

    return {
      url,
      status: 'ready',
    };
  } catch (error) {
    return {
      url: '',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
