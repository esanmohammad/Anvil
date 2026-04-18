// CLI command: ff runs — list and inspect pipeline runs

import { Command } from 'commander';
import { join } from 'node:path';
import pc from 'picocolors';
import { IndexReader } from '../run/index-reader.js';
import type { RunFilter } from '../run/index-reader.js';
import type { RunRecord, RunStatus } from '../run/types.js';
import { getFFDirs } from '../home.js';
import { error, info } from '../logger.js';

function getIndexReader(): IndexReader {
  const anvilDirs = getFFDirs();
  return new IndexReader(join(anvilDirs.runs, 'index.jsonl'));
}

function statusColor(status: RunStatus): string {
  switch (status) {
    case 'completed':
      return pc.green(status);
    case 'failed':
      return pc.red(status);
    case 'running':
      return pc.cyan(status);
    case 'cancelled':
      return pc.yellow(status);
    case 'pending':
    default:
      return pc.dim(status);
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function padEnd(str: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, len - stripped.length);
  return str + ' '.repeat(pad);
}

function renderTable(runs: RunRecord[]): string {
  const header = `${padEnd('ID', 22)} ${padEnd('SYSTEM', 14)} ${padEnd('FEATURE', 30)} ${padEnd('STATUS', 14)} DATE`;
  const sep = '-'.repeat(90);
  const lines = [header, sep];

  for (const run of runs) {
    const feature = run.feature.length > 28 ? run.feature.slice(0, 28) + '..' : run.feature;
    lines.push(
      `${padEnd(run.id, 22)} ${padEnd(run.project, 14)} ${padEnd(feature, 30)} ${padEnd(statusColor(run.status), 14)} ${formatDate(run.createdAt)}`,
    );
  }

  return lines.join('\n');
}

function renderDetail(run: RunRecord): string {
  const lines: string[] = [];
  lines.push(pc.bold(`Run: ${run.id}`));
  lines.push(`  Project:   ${run.project}`);
  lines.push(`  Feature:  ${run.feature}`);
  lines.push(`  Status:   ${statusColor(run.status)}`);
  lines.push(`  Created:  ${run.createdAt}`);
  lines.push(`  Updated:  ${run.updatedAt}`);

  if (run.totalCost) {
    lines.push(
      `  Cost:     $${run.totalCost.estimatedCost.toFixed(4)} (${run.totalCost.inputTokens} in / ${run.totalCost.outputTokens} out)`,
    );
  }

  if (run.prUrls && run.prUrls.length > 0) {
    lines.push('  PRs:');
    for (const url of run.prUrls) {
      lines.push(`    - ${url}`);
    }
  }

  if (run.branchName) {
    lines.push(`  Branch:   ${run.branchName}`);
  }

  lines.push('');
  lines.push(pc.bold('  Stages:'));
  for (const stage of run.stages) {
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
    const costStr = stage.cost
      ? ` ($${stage.cost.estimatedCost.toFixed(4)})`
      : '';
    lines.push(`    ${icon} ${stage.name} [${stage.status}]${costStr}`);
  }

  return lines.join('\n');
}

export const runsCommand = new Command('runs')
  .description('List recent pipeline runs')
  .option('--project <name>', 'Filter by project')
  .option('--failed', 'Show only failed runs')
  .option('--running', 'Show only running runs')
  .action(async (opts) => {
    const reader = getIndexReader();

    const filter: RunFilter = { limit: 20 };
    if (opts.project) {
      filter.project = opts.project;
    }
    if (opts.failed) {
      filter.status = 'failed';
    } else if (opts.running) {
      filter.status = 'running';
    }

    const runs = await reader.listRuns(filter);

    if (runs.length === 0) {
      info('No runs found.');
      return;
    }

    console.log(renderTable(runs));
  });

runsCommand
  .command('show')
  .argument('<run-id>', 'Run ID to show')
  .description('Show detailed run information')
  .action(async (runId: string) => {
    const reader = getIndexReader();
    const run = await reader.findRun(runId);

    if (!run) {
      error(`Run "${runId}" not found.`);
      process.exit(1);
    }

    console.log(renderDetail(run));
  });
