// Create a pull request using `gh pr create`

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PrCreateOptions {
  repo: string;
  branch: string;
  title: string;
  body: string;
  base?: string;
  labels?: string[];
}

export interface PrCreateResult {
  success: boolean;
  url: string;
  number: number;
  error?: string;
}

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

/**
 * Create a PR using `gh pr create`.
 */
export async function createPr(
  options: PrCreateOptions,
  execCommand: ExecCommand = defaultExecCommand,
): Promise<PrCreateResult> {
  const args = [
    'pr',
    'create',
    '--title',
    options.title,
    '--body',
    options.body,
    '--head',
    options.branch,
    '--repo',
    options.repo,
  ];

  if (options.base) {
    args.push('--base', options.base);
  }

  if (options.labels && options.labels.length > 0) {
    for (const label of options.labels) {
      args.push('--label', label);
    }
  }

  try {
    const { stdout } = await execCommand('gh', args);

    // Parse PR URL and number from gh output
    const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
    const url = urlMatch ? urlMatch[0] : stdout.trim();
    const number = urlMatch ? parseInt(urlMatch[1], 10) : 0;

    return { success: true, url, number };
  } catch (err) {
    return {
      success: false,
      url: '',
      number: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
