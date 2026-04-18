// CLI command: anvil rollback <run-id>
// Revert a pipeline run's changes — delete branches, close PRs, restore workspace

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';
import { RunStore, IndexReader } from '../run/index.js';
import { getFFDirs } from '../home.js';
import { createInterface } from 'node:readline';

function loadFactoryConfig(projectName: string): { repos: { name: string; path?: string }[] } | null {
  const anvilDirs = getFFDirs();
  const candidates = [
    join(anvilDirs.config, 'projects', projectName, 'factory.yaml'),
    join(anvilDirs.projects, projectName, 'factory.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf-8');
        // Simple YAML repo extraction — look for repo names under repos:
        const repos: { name: string; path?: string }[] = [];
        const repoMatches = raw.matchAll(/- name:\s*(.+)/g);
        for (const m of repoMatches) {
          repos.push({ name: m[1].trim() });
        }
        return { repos };
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export const rollbackCommand = new Command('rollback')
  .description('Revert a pipeline run — delete branches, close PRs, restore workspace')
  .argument('<run-id>', 'The run ID to rollback')
  .option('--keep-branches', 'Keep feature branches (only close PRs)')
  .option('--dry-run', 'Show what would be rolled back without doing it')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (runId: string, opts: { keepBranches?: boolean; dryRun?: boolean; yes?: boolean }) => {
    try {
      const anvilDirs = getFFDirs();
      const runStore = new RunStore(anvilDirs.runs);
      const indexReader = new IndexReader(join(anvilDirs.runs, 'index.jsonl'));

      // 1. Find the run record
      const record = await indexReader.findRun(runId);
      if (!record) {
        error(`Run not found: ${runId}`);
        process.exitCode = 1;
        return;
      }

      // 2. Extract details
      const projectName = record.project;
      const featureSlug = record.featureSlug;
      const branchName = record.branchName || `anvil/${featureSlug}`;
      const prUrls = record.prUrls || [];

      info(`Run:     ${pc.bold(runId)}`);
      info(`Project:  ${projectName}`);
      info(`Feature: ${record.feature}`);
      info(`Branch:  ${branchName}`);
      info(`PRs:     ${prUrls.length > 0 ? prUrls.join(', ') : 'none'}`);

      // 3. Dry run — show what would happen and exit
      if (opts.dryRun) {
        console.log('');
        info(pc.yellow('Dry run — no changes will be made:'));
        if (prUrls.length > 0) {
          for (const url of prUrls) {
            info(`  Would close PR: ${url}`);
          }
        }
        if (!opts.keepBranches) {
          info(`  Would delete local branch: ${branchName}`);
          info(`  Would delete remote branch: ${branchName}`);
        }
        return;
      }

      // 4. Prompt for confirmation
      if (!opts.yes) {
        console.log('');
        const confirmed = await confirm(
          pc.yellow('This will delete branches and close PRs. Continue?'),
        );
        if (!confirmed) {
          info('Rollback cancelled.');
          return;
        }
      }

      let closedPRs = 0;
      let deletedBranches = 0;

      // 5. Close PRs
      for (const url of prUrls) {
        try {
          info(`Closing PR: ${url}`);
          execSync(`gh pr close "${url}" --comment "Rolled back by anvil rollback"`, {
            stdio: 'pipe',
            timeout: 30_000,
          });
          closedPRs++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(`Failed to close PR ${url}: ${msg}`);
        }
      }

      // 6. Delete branches (unless --keep-branches)
      if (!opts.keepBranches) {
        // Try to resolve repos from factory.yaml
        const config = loadFactoryConfig(projectName);
        const workspacesDir = anvilDirs.workspaces;

        // Determine repo directories to operate on
        const repoDirs: string[] = [];

        if (config && config.repos.length > 0) {
          for (const repo of config.repos) {
            // Check common workspace locations
            const candidates = [
              join(workspacesDir, projectName, repo.name),
              join(workspacesDir, repo.name),
            ];
            for (const dir of candidates) {
              if (existsSync(join(dir, '.git'))) {
                repoDirs.push(dir);
                break;
              }
            }
          }
        }

        // Also check if current directory is a git repo as fallback
        if (repoDirs.length === 0) {
          const cwd = process.cwd();
          if (existsSync(join(cwd, '.git'))) {
            repoDirs.push(cwd);
          }
        }

        for (const repoDir of repoDirs) {
          // Checkout main/master first
          try {
            const defaultBranch = getDefaultBranch(repoDir);
            execSync(`git checkout ${defaultBranch}`, {
              cwd: repoDir,
              stdio: 'pipe',
              timeout: 15_000,
            });
          } catch {
            // May already be on main, or detached — continue
          }

          // Delete local branch
          try {
            execSync(`git branch -D "${branchName}"`, {
              cwd: repoDir,
              stdio: 'pipe',
              timeout: 15_000,
            });
            deletedBranches++;
            info(`Deleted local branch ${branchName} in ${repoDir}`);
          } catch {
            // Branch may not exist locally
          }

          // Delete remote branch
          try {
            execSync(`git push origin --delete "${branchName}"`, {
              cwd: repoDir,
              stdio: 'pipe',
              timeout: 30_000,
            });
            info(`Deleted remote branch ${branchName} in ${repoDir}`);
          } catch {
            // Remote branch may not exist
          }
        }

        if (repoDirs.length === 0) {
          warn('No repo directories found — skipping branch deletion. Run from the repo directory or ensure workspaces are configured.');
        }
      }

      // 7. Summary
      console.log('');
      success(
        `Rolled back run ${pc.bold(runId)}: closed ${closedPRs} PR${closedPRs !== 1 ? 's' : ''}, deleted ${deletedBranches} branch${deletedBranches !== 1 ? 'es' : ''}`,
      );
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

function getDefaultBranch(repoDir: string): string {
  try {
    const result = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 10_000,
    })
      .toString()
      .trim();
    // refs/remotes/origin/main -> main
    return result.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: check if main exists, otherwise master
    try {
      execSync('git rev-parse --verify main', {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 5_000,
      });
      return 'main';
    } catch {
      return 'master';
    }
  }
}
