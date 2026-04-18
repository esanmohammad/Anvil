// Add cross-links between related PRs using `gh pr edit`

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

/**
 * Append a "Related PRs" section to an existing PR body via `gh pr edit`.
 */
export async function addCrossLinks(
  prUrl: string,
  siblingUrls: string[],
  execCommand: ExecCommand = defaultExecCommand,
): Promise<{ success: boolean; error?: string }> {
  if (siblingUrls.length === 0) {
    return { success: true };
  }

  const crossLinksSection = [
    '',
    '### Related PRs',
    ...siblingUrls.map((url) => `- ${url}`),
  ].join('\n');

  try {
    await execCommand('gh', [
      'pr',
      'edit',
      prUrl,
      '--add-body',
      crossLinksSection,
    ]);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
