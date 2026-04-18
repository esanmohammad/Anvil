// Fix executor — Wave 9, Section A
// Executes a single-repo fix: clone, branch, engineer agent, validate

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FixExecutorConfig {
  repoPath: string;
  repoName: string;
  branchName: string;
  bugDescription: string;
  analysisReport: string;
  workingDir: string;
}

export interface FixResult {
  success: boolean;
  branchName: string;
  repoPath: string;
  filesChanged: string[];
  testsPassed: boolean;
  prUrl?: string;
  error?: string;
}

function runGit(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Git command failed: git ${args} — ${msg}`);
  }
}

function runTests(cwd: string): boolean {
  try {
    execSync('npm test --if-present', { cwd, encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function createPR(cwd: string, branchName: string, bugDescription: string): string | undefined {
  try {
    const title = `fix: ${bugDescription.slice(0, 72)}`;
    const body = `Automated fix for: ${bugDescription}`;
    const result = execSync(
      `gh pr create --title "${title}" --body "${body}" --head "${branchName}"`,
      { cwd, encoding: 'utf-8', stdio: 'pipe' },
    );
    return result.trim();
  } catch {
    return undefined;
  }
}

/**
 * Execute a fix in a single repository.
 * Steps: checkout branch, apply fix (via analysis report), run tests, create PR.
 */
export async function executeFix(config: FixExecutorConfig): Promise<FixResult> {
  const { repoPath, branchName, bugDescription, workingDir } = config;

  // Validate repo exists
  if (!existsSync(repoPath)) {
    return {
      success: false,
      branchName,
      repoPath,
      filesChanged: [],
      testsPassed: false,
      error: `Repository path does not exist: ${repoPath}`,
    };
  }

  try {
    // 1. Create and checkout branch
    runGit(`checkout -b ${branchName}`, repoPath);

    // 2. Get list of changed files (after engineer agent runs)
    // In real usage, the engineer agent would modify files here.
    // For now we detect any unstaged changes.
    const diffOutput = runGit('diff --name-only', repoPath);
    const filesChanged = diffOutput ? diffOutput.split('\n').filter(Boolean) : [];

    // 3. Stage and commit changes if any
    if (filesChanged.length > 0) {
      runGit('add -A', repoPath);
      runGit(`commit -m "fix: ${bugDescription.slice(0, 50)}"`, repoPath);
    }

    // 4. Run tests
    const testsPassed = runTests(repoPath);

    // 5. Push and create PR
    let prUrl: string | undefined;
    if (filesChanged.length > 0) {
      try {
        runGit(`push -u origin ${branchName}`, repoPath);
        prUrl = createPR(repoPath, branchName, bugDescription);
      } catch {
        // Push/PR creation is optional
      }
    }

    return {
      success: testsPassed,
      branchName,
      repoPath,
      filesChanged,
      testsPassed,
      prUrl,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      branchName,
      repoPath,
      filesChanged: [],
      testsPassed: false,
      error: msg,
    };
  }
}
