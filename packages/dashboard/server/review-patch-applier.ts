/**
 * review-patch-applier — apply a unified-diff patch against a repo via a
 * scratch git worktree. Optionally run tests before committing; rollback
 * cleanly on any failure.
 */

import { execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ApplyPatchInput {
  project: string;
  findingId: string;
  proposedPatch: string;
  runTests?: boolean;
}

export interface ApplyPatchResult {
  applied: boolean;
  commitSha?: string;
  testsPassed?: boolean;
  error?: string;
  stderr?: string;
}

export type Runner = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'go-test';

function buildTestCommand(runner: Runner, scope: string): { cmd: string; args: string[] } {
  switch (runner) {
    case 'vitest': return { cmd: 'npx', args: ['vitest', 'run', scope] };
    case 'jest':   return { cmd: 'npx', args: ['jest', '--findRelatedTests', scope, '--passWithNoTests'] };
    case 'mocha':  return { cmd: 'npx', args: ['mocha', scope] };
    case 'pytest': return { cmd: 'pytest', args: [scope, '-q'] };
    case 'go-test': return { cmd: 'go', args: ['test', `./${scope}/...`] };
  }
}

export async function applyReviewPatch(
  input: ApplyPatchInput,
  deps: { repoLocalPath: string; runner?: Runner },
): Promise<ApplyPatchResult> {
  const { repoLocalPath } = deps;
  if (!existsSync(repoLocalPath)) {
    return { applied: false, error: `repo not found: ${repoLocalPath}` };
  }

  const wt = mkdtempSync(join(tmpdir(), `anvil-patch-${input.findingId}-`));
  const cleanup = (): void => {
    try { execSync(`git worktree remove --force "${wt}"`, { cwd: repoLocalPath, stdio: 'pipe' }); } catch { /* ok */ }
    try { rmSync(wt, { recursive: true, force: true }); } catch { /* ok */ }
  };

  try {
    execSync(`git worktree add --detach "${wt}" HEAD`, { cwd: repoLocalPath, stdio: 'pipe' });
    const patchFile = join(wt, '.anvil-pending.patch');
    writeFileSync(patchFile, input.proposedPatch, 'utf-8');

    try {
      execFileSync('git', ['apply', '--3way', patchFile], { cwd: wt, stdio: 'pipe' });
    } catch (err) {
      cleanup();
      return { applied: false, error: 'patch failed to apply', stderr: err instanceof Error ? err.message : String(err) };
    }

    let testsPassed: boolean | undefined;
    if (input.runTests && deps.runner) {
      const cmd = buildTestCommand(deps.runner, '.');
      try {
        execFileSync(cmd.cmd, cmd.args, { cwd: wt, stdio: 'pipe', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
        testsPassed = true;
      } catch (err) {
        cleanup();
        return { applied: false, testsPassed: false, error: 'tests failed', stderr: err instanceof Error ? err.message : String(err) };
      }
    }

    execFileSync('git', ['add', '-A'], { cwd: wt, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `anvil-apply: fix ${input.findingId}`], { cwd: wt, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).trim();

    // Cherry-pick into the live working tree of the original repo.
    try {
      execFileSync('git', ['fetch', wt, sha], { cwd: repoLocalPath, stdio: 'pipe' });
      execFileSync('git', ['cherry-pick', sha], { cwd: repoLocalPath, stdio: 'pipe' });
    } catch (err) {
      // Cherry-pick may conflict — surface but the commit is already in the worktree.
      cleanup();
      return {
        applied: false, commitSha: sha,
        error: 'patch committed in worktree but cherry-pick to live repo failed',
        stderr: err instanceof Error ? err.message : String(err),
      };
    }

    cleanup();
    return { applied: true, commitSha: sha, testsPassed };
  } catch (err) {
    cleanup();
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}
