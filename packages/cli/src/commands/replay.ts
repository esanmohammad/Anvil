// CLI command: anvil replay <run-id>
// Replay a past pipeline run from a specific stage — UX wrapper around retry

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error } from '../logger.js';
import { RunStore, IndexReader, STAGE_NAMES } from '../run/index.js';
import { getFFDirs } from '../home.js';
import type { RunRecord } from '../run/types.js';

const STAGE_NAME_MAP: Record<string, number> = {
  clarify: 0,
  requirements: 1,
  'project-requirements': 2,
  specs: 3,
  tasks: 4,
  build: 5,
  validate: 6,
  ship: 7,
};

function resolveStage(input: string): number | null {
  // Try as number first
  const num = parseInt(input, 10);
  if (!isNaN(num) && num >= 0 && num <= 7) {
    return num;
  }
  // Try as name
  const lower = input.toLowerCase();
  if (lower in STAGE_NAME_MAP) {
    return STAGE_NAME_MAP[lower];
  }
  return null;
}

function formatCost(record: RunRecord): string {
  if (!record.totalCost) return 'N/A';
  return `$${record.totalCost.estimatedCost.toFixed(4)} (${record.totalCost.inputTokens} in / ${record.totalCost.outputTokens} out)`;
}

function renderRunSummary(record: RunRecord): void {
  console.log('');
  console.log(pc.bold(`Run: ${record.id}`));
  console.log(`  Project:    ${record.project}`);
  console.log(`  Feature:   ${record.feature}`);
  console.log(`  Status:    ${record.status}`);
  console.log(`  Cost:      ${formatCost(record)}`);
  console.log(`  Created:   ${record.createdAt}`);

  if (record.branchName) {
    console.log(`  Branch:    ${record.branchName}`);
  }
  if (record.prUrls && record.prUrls.length > 0) {
    console.log(`  PRs:       ${record.prUrls.join(', ')}`);
  }

  console.log('');
  console.log(pc.bold('  Stages:'));
  for (const stage of record.stages) {
    const icon =
      stage.status === 'completed'
        ? pc.green('\u2713')
        : stage.status === 'failed'
          ? pc.red('\u2717')
          : stage.status === 'running'
            ? pc.cyan('\u231B')
            : stage.status === 'skipped'
              ? pc.dim('\u23ED')
              : pc.dim('\u00B7');
    const costStr = stage.cost ? ` ($${stage.cost.estimatedCost.toFixed(4)})` : '';
    console.log(`    ${icon} ${stage.name} [${stage.status}]${costStr}`);
  }
  console.log('');
}

export const replayCommand = new Command('replay')
  .description('Replay a past pipeline run from a specific stage')
  .argument('<run-id>', 'The run ID to replay')
  .option('--from <stage>', 'Stage to replay from (0-7 or name: clarify, requirements, specs, tasks, build, validate, ship)')
  .option('--model <model>', 'Override model for replay')
  .action(async (runId: string, opts: { from?: string; model?: string }) => {
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

      // 2. Display run summary
      renderRunSummary(record);

      // 3. Resolve the --from stage
      let fromStage = 0;
      if (opts.from) {
        const resolved = resolveStage(opts.from);
        if (resolved === null) {
          error(
            `Invalid stage: "${opts.from}". Use 0-7 or a name: ${Object.keys(STAGE_NAME_MAP).join(', ')}`,
          );
          process.exitCode = 1;
          return;
        }
        fromStage = resolved;
      } else {
        // Default: find the first non-completed stage, or 0
        const firstIncomplete = record.stages.findIndex(
          (s) => s.status !== 'completed',
        );
        fromStage = firstIncomplete >= 0 ? firstIncomplete : 0;
        info(`Auto-detected replay start: stage ${fromStage} (${STAGE_NAMES[fromStage]})`);
      }

      info(
        `Replaying run ${pc.bold(runId)} from stage ${fromStage} (${pc.cyan(STAGE_NAMES[fromStage])})...`,
      );

      // 4. Delegate to retry — update run record stages and mark as running
      const updatedStages = record.stages.map((stage, idx) => {
        if (idx >= fromStage) {
          return { ...stage, status: 'pending' as const, completedAt: undefined, cost: undefined };
        }
        return stage;
      });

      await runStore.updateRun(runId, {
        status: 'running',
        stages: updatedStages,
      });

      const equivalent = `anvil retry ${runId} --from ${fromStage}`;
      info(`Equivalent: ${pc.dim(equivalent)}`);

      success(
        `Run ${pc.bold(runId)} queued for replay from stage ${fromStage} (${STAGE_NAMES[fromStage]})`,
      );
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
