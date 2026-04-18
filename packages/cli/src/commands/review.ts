// CLI command: anvil review <project>
// Wave 9, Section B — Review Workflow

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { findProject } from '../project/loader.js';
import { getFFDirs } from '../home.js';
import { error, success, info, warn } from '../logger.js';
import { reviewDiff } from '../workflows/diff-reviewer.js';
import { checkConventions } from '../workflows/convention-checker.js';
import { formatReviewReport } from '../workflows/review-reporter.js';
import type { ConventionRule } from '../conventions/rules/types.js';
import { loadKnowledgeGraph } from '../context/knowledge-graph.js';
import pc from 'picocolors';

function getRepoDiff(repoPath: string): string {
  try {
    return execSync('git diff HEAD', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    return '';
  }
}

function getRepoStatus(repoPath: string): string {
  try {
    return execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

export const reviewCommand = new Command('review')
  .description('Review code changes across project repositories')
  .argument('<project>', 'The project to review')
  .option('--conventions', 'Also check against convention rules')
  .action(async (projectName: string, opts: Record<string, unknown>) => {
    const anvilDirs = getFFDirs();

    // 1. Validate project exists
    let project;
    try {
      project = await findProject(anvilDirs.projects, projectName);
    } catch {
      error(`Project "${projectName}" not found. Run "anvil project list" to see available projects.`);
      process.exit(1);
      return;
    }

    info(`Reviewing code changes for project "${projectName}"`);

    // Log integration usage
    info(`[project-context] Loaded project "${projectName}" (${project.repos.length} repos: ${project.repos.map(r => r.name).join(', ')})`);
    const kb = await loadKnowledgeGraph(projectName, 'code review quality conventions');
    if (kb) {
      info(`[knowledge-base] KB available for "${projectName}" (${kb.length} chars)`);
    } else {
      warn(`[knowledge-base] No KB available for "${projectName}"`);
    }

    // 2. Scan repos for dirty branches
    const reposWithChanges: Array<{ name: string; path: string; diff: string }> = [];

    for (const repo of project.repos) {
      const repoPath = repo.github;
      const status = getRepoStatus(repoPath);
      if (status) {
        const diff = getRepoDiff(repoPath);
        if (diff) {
          reposWithChanges.push({ name: repo.name, path: repoPath, diff });
        }
      }
    }

    if (reposWithChanges.length === 0) {
      info('No repositories with uncommitted changes found.');
      process.exit(0);
      return;
    }

    info(`Found ${reposWithChanges.length} repo(s) with changes`);

    // 3. Review each repo's diff
    for (const repo of reposWithChanges) {
      console.log('');
      console.log(pc.bold(`--- ${repo.name} ---`));

      const diffResults = reviewDiff(repo.diff);
      const conventionResult = opts.conventions
        ? checkConventions(repo.diff, [])
        : undefined;

      const report = formatReviewReport(diffResults, conventionResult);

      console.log(report.markdown);

      if (report.overallScore >= 80) {
        success(`Score: ${report.overallScore}/100`);
      } else if (report.overallScore >= 50) {
        info(`Score: ${report.overallScore}/100`);
      } else {
        error(`Score: ${report.overallScore}/100`);
      }
    }

    process.exit(0);
  });
