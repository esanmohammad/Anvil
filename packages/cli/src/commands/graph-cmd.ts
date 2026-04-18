import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';

// ── Minimal config reading ──────────────────────────────────────────────

function getAnvilHome(): string {
  return process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
}

function findProjectConfigs(): Array<{ name: string; configPath: string }> {
  const home = getAnvilHome();
  const entries: Array<{ name: string; configPath: string }> = [];

  for (const dir of ['projects', 'projects']) {
    const base = join(home, dir);
    if (!existsSync(base)) continue;
    try {
      for (const name of readdirSync(base)) {
        if (name.startsWith('.')) continue;
        if (entries.some(e => e.name === name)) continue;
        const yamlName = dir === 'projects' ? 'factory.yaml' : 'project.yaml';
        const yamlPath = join(base, name, yamlName);
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  return entries;
}

// ── Command definition ──────────────────────────────────────────────────

export const graphCommand = new Command('graph')
  .description('Build and manage LLM-powered project graphs');

// ── Subcommand: build ───────────────────────────────────────────────────

graphCommand.addCommand(
  new Command('build')
    .description('Build a semantic project graph using AI')
    .argument('[project]', 'Project name')
    .option('--provider <name>', 'LLM provider: openai, anthropic, gemini, openrouter')
    .option('--model <model>', 'Override model (e.g., gpt-4o, claude-sonnet-4-20250514)')
    .option('--dry-run', 'Show prompt without calling LLM')
    .action(async (projectName, opts) => {
      const { buildProjectGraph } = await import('../knowledge/project-graph-builder.js');

      // Resolve project
      let configPath: string | undefined;
      if (projectName) {
        const configs = findProjectConfigs();
        const found = configs.find(c => c.name === projectName);
        if (found) {
          configPath = found.configPath;
        } else {
          error(`Project "${projectName}" not found. Available: ${configs.map(c => c.name).join(', ') || 'none'}`);
          process.exitCode = 1;
          return;
        }
      } else {
        // Interactive selection
        const configs = findProjectConfigs();
        if (configs.length === 0) {
          error('No projects configured. Run: anvil init');
          process.exitCode = 1;
          return;
        }
        if (configs.length === 1) {
          projectName = configs[0].name;
          configPath = configs[0].configPath;
        } else {
          const { createInterface } = await import('node:readline');
          console.log('');
          info('Select a project:');
          for (let i = 0; i < configs.length; i++) {
            console.log(`  ${pc.cyan(`${i + 1}`)}  ${configs[i].name}`);
          }
          console.log('');

          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question('  Project number: ', (a) => { rl.close(); resolve(a); });
          });
          const idx = parseInt(answer, 10) - 1;
          if (idx < 0 || idx >= configs.length) {
            error('Invalid selection.');
            process.exitCode = 1;
            return;
          }
          projectName = configs[idx].name;
          configPath = configs[idx].configPath;
        }
      }

      if (!configPath || !projectName) {
        error('Could not resolve project configuration.');
        process.exitCode = 1;
        return;
      }

      console.log('');
      info(`Building project graph for ${pc.bold(projectName)}...`);
      console.log('');

      try {
        const graph = await buildProjectGraph(projectName, configPath, {
          provider: opts.provider,
          model: opts.model,
          dryRun: opts.dryRun,
          onProgress: (msg) => info(`  ${msg}`),
        });

        console.log('');
        if (opts.dryRun) {
          success('Dry run complete. Prompt assembled successfully.');
          info(`  Estimated input tokens: ${graph.meta.inputTokens}`);
        } else {
          success(`Project graph built for ${pc.bold(projectName)}`);
          console.log('');
          info(`  Model:    ${graph.meta.model} (${graph.meta.provider})`);
          info(`  Cost:     $${graph.meta.costUsd.toFixed(4)}`);
          info(`  Tokens:   ${graph.meta.inputTokens} in / ${graph.meta.outputTokens} out`);
          info(`  Duration: ${(graph.meta.durationMs / 1000).toFixed(1)}s`);
          info(`  Repos:    ${Object.keys(graph.repoRoles).length} roles`);
          info(`  Flows:    ${graph.keyFlows.length} key flows`);
          info(`  Edges:    ${graph.relationships.length} cross-repo relationships`);
          console.log('');
          info(`  View: anvil graph show ${projectName}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to build project graph: ${msg}`);
        process.exitCode = 1;
      }
    }),
);

// ── Subcommand: show ────────────────────────────────────────────────────

graphCommand.addCommand(
  new Command('show')
    .description('Show the project graph summary')
    .argument('[project]', 'Project name')
    .action(async (projectName) => {
      const { loadProjectSummary, getProjectGraphStatus } = await import('../knowledge/project-graph-builder.js');

      if (!projectName) {
        const configs = findProjectConfigs();
        if (configs.length === 1) {
          projectName = configs[0].name;
        } else {
          error('Specify a project name: anvil graph show <project>');
          process.exitCode = 1;
          return;
        }
      }

      const status = getProjectGraphStatus(projectName);
      if (!status.exists) {
        error(`No project graph for "${projectName}". Build one with: anvil graph build ${projectName}`);
        process.exitCode = 1;
        return;
      }

      const summary = loadProjectSummary(projectName);
      if (summary) {
        console.log(summary);
      } else {
        error('PROJECT_SUMMARY.md not found.');
        process.exitCode = 1;
      }
    }),
);

// ── Subcommand: cost ────────────────────────────────────────────────────

graphCommand.addCommand(
  new Command('cost')
    .description('Estimate cost of building a project graph')
    .argument('[project]', 'Project name')
    .option('--provider <name>', 'LLM provider: openai, anthropic, gemini, openrouter')
    .action(async (projectName, opts) => {
      const { estimateProjectGraphCost } = await import('../knowledge/project-graph-builder.js');

      if (!projectName) {
        const configs = findProjectConfigs();
        if (configs.length === 1) {
          projectName = configs[0].name;
        } else {
          error('Specify a project name: anvil graph cost <project>');
          process.exitCode = 1;
          return;
        }
      }

      const configs = findProjectConfigs();
      const found = configs.find(c => c.name === projectName);
      if (!found) {
        error(`Project "${projectName}" not found.`);
        process.exitCode = 1;
        return;
      }

      try {
        const estimate = estimateProjectGraphCost(projectName, found.configPath, opts.provider);
        console.log('');
        info(`Cost estimate for ${pc.bold(projectName)} project graph:`);
        console.log('');
        info(`  Provider: ${estimate.provider}`);
        info(`  Model:    ${estimate.model}`);
        info(`  Input:    ~${estimate.estimatedInputTokens} tokens`);
        info(`  Output:   ~${estimate.estimatedOutputTokens} tokens`);
        info(`  Cost:     ~$${estimate.estimatedCostUsd.toFixed(4)}`);
        console.log('');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Cannot estimate cost: ${msg}`);
        process.exitCode = 1;
      }
    }),
);

// ── Subcommand: status ──────────────────────────────────────────────────

graphCommand.addCommand(
  new Command('status')
    .description('Show project graph status')
    .argument('[project]', 'Project name')
    .action(async (projectName) => {
      const { getProjectGraphStatus } = await import('../knowledge/project-graph-builder.js');

      const configs = findProjectConfigs();
      const projects = projectName
        ? configs.filter(c => c.name === projectName)
        : configs;

      if (projects.length === 0) {
        error(projectName ? `Project "${projectName}" not found.` : 'No projects configured.');
        process.exitCode = 1;
        return;
      }

      console.log('');
      info('Project Graph Status');
      console.log('');

      for (const proj of projects) {
        const status = getProjectGraphStatus(proj.name);
        if (status.exists) {
          const age = status.generatedAt
            ? timeSince(new Date(status.generatedAt))
            : 'unknown';
          console.log(`  ${pc.green('●')} ${pc.bold(proj.name)} — built ${age} ago with ${status.model} ($${status.costUsd?.toFixed(4)})`);
        } else {
          console.log(`  ${pc.dim('○')} ${pc.bold(proj.name)} — not built`);
        }
      }
      console.log('');
    }),
);

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
