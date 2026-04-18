// CLI command: anvil run <project> "<feature>"

import { Command } from 'commander';
import { runPipeline } from '../pipeline/orchestrator.js';
import type { OrchestratorResult, PipelineDependencies } from '../pipeline/orchestrator.js';
import { loadAll, findAndResolve } from '../project/loader.js';
import { getFFDirs } from '../home.js';
import { RunStore } from '../run/index.js';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentRunner } from '../pipeline/stages/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { ProviderName } from '../providers/types.js';
import { error, success, info, warn } from '../logger.js';
import { estimatePipelineCost, formatCostEstimate } from '../pipeline/cost-estimator.js';
import { getModelForStage } from '../pipeline/model-router.js';
import type { ModelTier } from '../pipeline/model-router.js';
import { StageProgress } from '../ui/progress.js';
import { printPipelineSummary } from '../ui/summary.js';
import type { PipelineSummaryData, StageSummary } from '../ui/summary.js';
import pc from 'picocolors';

/**
 * Create an AgentRunner that uses the provider registry to resolve the
 * correct adapter for each stage.
 *
 * All adapters emit Anvil Stream Format NDJSON, so the parsing logic is
 * identical regardless of backend provider. We pipe the adapter's output
 * through a PassThrough stream to process.stdout for dashboard capture,
 * and parse NDJSON lines in parallel for result extraction.
 */
function createAgentRunner(providerName?: ProviderName, defaultModel?: string): AgentRunner {
  const registry = ProviderRegistry.getInstance();

  return {
    async run(config) {
      const model = config.model ?? defaultModel ?? 'claude-sonnet-4-6';
      const provider = (config.provider as ProviderName) ?? providerName;

      const { adapter, provider: resolvedProvider, warning } = registry.resolveForStage(
        config.stage,
        model,
        provider,
      );

      if (warning) {
        warn(warning);
      }

      // Create a PassThrough stream that forwards to stdout and parses NDJSON
      const { PassThrough } = await import('node:stream');
      const stream = new PassThrough();

      let output = '';
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;

      stream.on('data', (data: Buffer) => {
        const chunk = data.toString();
        // Forward raw stream-json to our stdout so dashboard server can capture it
        process.stdout.write(chunk);

        // Parse stream-json for result extraction
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === 'assistant' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text' && block.text) {
                  output += block.text;
                }
              }
            } else if (msg.type === 'result') {
              if (msg.result) output = msg.result;
              inputTokens = msg.usage?.input_tokens ?? 0;
              outputTokens = msg.usage?.output_tokens ?? 0;
            }
          } catch { /* skip non-JSON */ }
        }
      });

      // Run the adapter — it writes Anvil Stream Format NDJSON to the stream
      const result = await adapter.run(
        {
          userPrompt: config.userPrompt,
          projectPrompt: config.projectPrompt,
          model,
          workingDir: config.workingDir,
          stage: config.stage,
          persona: config.persona,
        },
        stream,
      );

      // Prefer result from the adapter, fall back to stream-parsed output
      return {
        output: result.output || output,
        tokenEstimate: result.inputTokens + result.outputTokens || inputTokens + outputTokens,
      };
    },
  };
}

function askConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

function countProjectRepos(project: string): number {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      const matches = raw.matchAll(/^\s{2,4}-\s+name:\s+/gm);
      let count = 0;
      for (const _ of matches) count++;
      return Math.max(count, 1);
    } catch { /* ignore */ }
  }
  return 1;
}

function estimateKbSize(project: string): number {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const kbDir = join(anvilHome, 'knowledge-base', project);
  if (!existsSync(kbDir)) return 0;
  try {
    let totalBytes = 0;
    const entries = readdirSync(kbDir, { recursive: true, withFileTypes: false }) as string[];
    for (const entry of entries) {
      try {
        const st = statSync(join(kbDir, entry));
        if (st.isFile()) totalBytes += st.size;
      } catch { /* skip unreadable files */ }
    }
    return totalBytes;
  } catch {
    return 0;
  }
}

export const runFeatureCommand = new Command('run')
  .argument('<project>', 'Project name')
  .argument('<feature>', 'Feature description')
  .option('--no-clarify', 'Skip clarification stage')
  .option('--skip-ship', 'Skip shipping stage')
  .option('--deploy [mode]', 'Deploy after shipping: "local" or "remote"', false)
  .option('--answers <file>', 'Pre-filled answers file')
  .option('--model <model>', 'Model to use (e.g., claude-sonnet-4-6, gpt-4.1)')
  .option('--provider <name>', 'Force a specific provider (claude, openai, gemini, openrouter, ollama, gemini-cli, adk)')
  .option('--check-providers', 'Check availability of all registered providers and exit')
  .option('--approval', 'Require approval between stages')
  .option('--dry-run', 'Show estimated cost and plan without running')
  .option('-y, --yes', 'Skip cost confirmation prompt')
  .option('--tier <tier>', 'Model routing tier: fast, balanced, thorough', 'balanced')
  .description('Run the full Anvil pipeline')
  .action(async (project: string, feature: string, opts: any) => {
    // --check-providers: print availability of all registered providers and exit
    if (opts.checkProviders) {
      const registry = ProviderRegistry.getInstance();
      const results = await registry.checkAll();
      console.error(pc.bold('\nProvider Availability:\n'));
      for (const [name, result] of results) {
        const status = result.available
          ? pc.green('OK')
          : pc.red('UNAVAILABLE');
        const version = result.version ? ` (${result.version})` : '';
        const tier = pc.dim(`[${result.tier}]`);
        const err = result.error ? pc.dim(` — ${result.error}`) : '';
        console.error(`  ${status}  ${name.padEnd(14)} ${tier}${version}${err}`);
      }
      console.error('');
      return;
    }

    const anvilDirs = getFFDirs();

    // 1. Validate project exists
    try {
      await findAndResolve(anvilDirs.projects, project);
    } catch {
      error(`Project "${project}" not found. Run "anvil project list" to see available projects.`);
      process.exit(1);
    }

    const repoCount = countProjectRepos(project);
    const model = opts.model || 'claude-sonnet-4-6';
    const tier = (opts.tier || 'balanced') as ModelTier;

    // Estimate KB size from knowledge-base directory
    const kbSize = estimateKbSize(project);

    // Cost estimation
    const estimate = estimatePipelineCost({
      project,
      feature,
      repoCount,
      kbSize,
      model,
      skipClarify: opts.clarify === false,
      skipShip: opts.skipShip ?? false,
    });

    // Dry run mode — show plan and exit
    if (opts.dryRun) {
      console.error('');
      console.error(pc.bold(`Dry Run — anvil run ${project} "${feature}"`));
      console.error('');
      console.error(`  Project: ${project} (${repoCount} repo${repoCount !== 1 ? 's' : ''})`);
      console.error(`  Model:   ${model}`);
      console.error(`  Tier:    ${tier}`);
      console.error('');
      console.error(pc.bold('  Pipeline Plan:'));
      for (let i = 0; i < estimate.stages.length; i++) {
        const s = estimate.stages[i];
        const stageModel = getModelForStage(s.name, tier);
        const shortModel = stageModel.includes('haiku') ? 'haiku' : stageModel.includes('opus') ? 'opus' : 'sonnet';
        console.error(`    ${i + 1}. ${s.name.padEnd(22)} → ${shortModel.padEnd(8)} ~$${s.estimatedCost.toFixed(2)}`);
      }
      console.error('');
      console.error(`  Estimated cost: ${formatCostEstimate(estimate)}`);
      console.error('');
      return;
    }

    // Cost confirmation (unless --yes)
    if (!opts.yes) {
      console.error(`  Estimated cost: ${formatCostEstimate(estimate)}`);
      const confirmed = await askConfirmation(`  Continue? [Y/n] `);
      if (!confirmed) {
        info('Cancelled.');
        return;
      }
    }

    info(`Starting pipeline for project "${project}"`);
    info(`Feature: ${feature}`);

    // 2. Resolve workspace directory at ~/workspace/<project>/
    const workspaceRoot = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || process.env.X_WORKSPACE_ROOT || join(homedir(), 'workspace');
    const workspaceDir = join(workspaceRoot, project);

    if (!existsSync(workspaceDir)) {
      info(`Workspace not found at ${workspaceDir}`);
      warn('Continuing without workspace — agent will have limited context. Clone repos first or set ANVIL_WORKSPACE_ROOT.');
    } else {
      info(`Using workspace: ${workspaceDir}`);
    }

    // 3. Build pipeline dependencies — paths point to workspace clones
    const deps: PipelineDependencies = {
      agentRunner: createAgentRunner(opts.provider as ProviderName | undefined, opts.model),
      runStore: new RunStore(anvilDirs.runs),
      projectLoader: {
        findProject: async (name: string) => {
          const sys = await findAndResolve(anvilDirs.projects, name);
          const wsDir = join(workspaceRoot, name);
          return {
            project: sys.project,
            repos: sys.repos.map((r) => ({
              name: r.name,
              path: join(wsDir, r.name),  // workspace path
            })),
          };
        },
        loadAll: async () => {
          const projects = await loadAll(anvilDirs.projects);
          return projects.map((s) => ({
            project: s.project,
            repos: s.repos.map((r) => ({
              name: r.name,
              path: join(workspaceRoot, s.project, r.name),
            })),
          }));
        },
      },
    };

    // 3. Call runPipeline with dependencies
    let result: OrchestratorResult;
    try {
      result = await runPipeline(
        {
          project,
          feature,
          skipClarify: opts.clarify === false,
          skipShip: opts.skipShip ?? false,
          deploy: opts.deploy === true ? 'local' : opts.deploy || false,
          answersFile: opts.answers,
          model: opts.model,
          approvalRequired: opts.approval ?? false,
        },
        deps,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Pipeline failed: ${msg}`);
      process.exit(1);
      return;
    }

    // 4. Display final summary
    console.log('');
    if (result.status === 'completed') {
      success(`Pipeline completed successfully`);
      console.log(`  Run ID: ${pc.bold(result.runId)}`);
      console.log(
        `  Cost:   $${result.totalCost.estimatedCost.toFixed(4)} ` +
          `(${result.totalCost.inputTokens} in / ${result.totalCost.outputTokens} out)`,
      );
      if (result.prUrls.length > 0) {
        console.log('  Pull Requests:');
        for (const url of result.prUrls) {
          console.log(`    - ${url}`);
        }
      }
      if (result.sandboxUrl) {
        console.log(`  Sandbox: ${result.sandboxUrl}`);
      }
    } else {
      error(`Pipeline failed at stage ${result.failedStage}: ${result.failedError}`);
      console.log(`  Run ID: ${pc.bold(result.runId)}`);
    }

    process.exit(result.status === 'completed' ? 0 : 1);
  });
