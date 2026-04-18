// CLI command: anvil fix <project> "<bug>"
// Wave 9, Section A — Quick Fix Workflow

import { Command } from 'commander';
import { findProject } from '../project/loader.js';
import { getFFDirs } from '../home.js';
import { error, success, info, warn } from '../logger.js';
import { runFixPipeline } from '../workflows/fix-pipeline.js';
import type { FixPipelineResult } from '../workflows/fix-pipeline.js';
import { loadKnowledgeGraph } from '../context/knowledge-graph.js';
import pc from 'picocolors';

export const fixCommand = new Command('fix')
  .description('Auto-fix a bug in a project (abbreviated pipeline)')
  .argument('<project>', 'The project to fix')
  .argument('<bug>', 'Description of the bug to fix')
  .option('--branch-prefix <prefix>', 'Branch name prefix', 'fix')
  .option('--no-pr', 'Skip PR creation')
  .action(async (projectName: string, bugDescription: string, opts: Record<string, unknown>) => {
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

    info(`Starting fix pipeline for project "${projectName}"`);
    info(`Bug: ${bugDescription}`);

    // Log integration usage
    info(`[project-context] Loaded project "${projectName}" (${project.repos.length} repos: ${project.repos.map(r => r.name).join(', ')})`);
    const kb = await loadKnowledgeGraph(projectName, bugDescription);
    if (kb) {
      info(`[knowledge-base] KB available for "${projectName}" (${kb.length} chars)`);
    } else {
      warn(`[knowledge-base] No KB available for "${projectName}" — fix agent will explore codebase manually`);
    }

    // 2. Build repo list with paths
    const repos = project.repos.map((r) => ({
      name: r.name,
      path: r.github, // fallback; real path resolution would happen via workspace
    }));

    if (repos.length === 0) {
      error('Project has no repositories configured.');
      process.exit(1);
      return;
    }

    // 3. Run the fix pipeline
    let result: FixPipelineResult;
    try {
      result = await runFixPipeline({
        project: projectName,
        bugDescription,
        repos,
        branchPrefix: (opts.branchPrefix as string) ?? 'fix',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Fix pipeline failed: ${msg}`);
      process.exit(1);
      return;
    }

    // 4. Display results
    console.log('');
    if (result.status === 'success') {
      success('Fix applied successfully to all repositories');
    } else if (result.status === 'partial') {
      info(`Fix partially applied (${result.successCount}/${result.totalRepos} repos)`);
    } else {
      error('Fix failed in all repositories');
    }

    for (const r of result.results) {
      const icon = r.success ? pc.green('OK') : pc.red('FAIL');
      console.log(`  ${icon} ${r.repoPath}`);
      if (r.filesChanged.length > 0) {
        console.log(`       Files: ${r.filesChanged.join(', ')}`);
      }
      if (r.prUrl) {
        console.log(`       PR: ${r.prUrl}`);
      }
      if (r.error) {
        console.log(`       Error: ${r.error}`);
      }
    }

    process.exit(result.status === 'failed' ? 1 : 0);
  });
