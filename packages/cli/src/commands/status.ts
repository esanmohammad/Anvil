// CLI commands: ff status, ff stats
// Wave 9, Sections C & D

import { Command } from 'commander';
import { join } from 'node:path';
import { getFFDirs } from '../home.js';
import { IndexReader } from '../run/index-reader.js';
import type { RunRecord } from '../run/types.js';
import { error, info } from '../logger.js';
import { collectPipelineStatus } from '../analytics/pipeline-status.js';
import { collectPendingPrs } from '../analytics/pending-prs.js';
import { aggregateStats } from '../analytics/stats-aggregator.js';
import { formatStats, formatDuration } from '../analytics/stats-formatter.js';
import pc from 'picocolors';

// ---------------------------------------------------------------------------
// ff status — show running pipelines, active sandboxes, pending PRs
// ---------------------------------------------------------------------------

export const statusCommand = new Command('status')
  .description('Show current pipeline status, active sandboxes, and pending PRs')
  .option('--project <name>', 'Filter by project')
  .action(async (opts: Record<string, unknown>) => {
    const anvilDirs = getFFDirs();
    const indexReader = new IndexReader(join(anvilDirs.runs, 'index.jsonl'));

    let runs: RunRecord[];
    try {
      runs = await indexReader.listRuns(
        opts.project ? { project: opts.project as string } : undefined,
      );
    } catch {
      runs = [];
    }

    const activePipelines = collectPipelineStatus(runs);
    const completedRuns = runs.filter(
      (r) => r.prUrls && r.prUrls.length > 0,
    );
    const pendingPrs = collectPendingPrs(completedRuns.slice(0, 20));
    const openPrs = pendingPrs.filter((p) => p.state === 'open');

    // Nothing going on — keep it clean
    if (activePipelines.length === 0 && openPrs.length === 0) {
      info('All clear — no active pipelines or open PRs.');
      return;
    }

    console.log('');

    if (activePipelines.length > 0) {
      console.log(pc.bold('Active Pipelines'));
      console.log(pc.dim('─'.repeat(60)));
      for (const p of activePipelines) {
        const elapsed = formatDuration(p.elapsedMs);
        console.log(
          `  ${pc.blue(p.runId)} ${pc.bold(p.project)} — ${p.feature}`,
        );
        console.log(
          `    Stage: ${pc.yellow(p.currentStage)} | Elapsed: ${elapsed}`,
        );
      }
      console.log('');
    }

    if (openPrs.length > 0) {
      console.log(pc.bold('Pending Pull Requests'));
      console.log(pc.dim('─'.repeat(60)));
      for (const pr of openPrs) {
        const checksColor =
          pr.checks === 'passing' ? pc.green : pr.checks === 'failing' ? pc.red : pc.yellow;
        console.log(`  ${pr.url}`);
        console.log(
          `    ${pr.title} | Checks: ${checksColor(pr.checks)}`,
        );
      }
      console.log('');
    }

    info(`${activePipelines.length} active pipeline(s), ${openPrs.length} open PR(s)`);
  });

// ---------------------------------------------------------------------------
// ff stats — show statistics with filters
// ---------------------------------------------------------------------------

export const statsCommand = new Command('stats')
  .description('Show Anvil statistics')
  .option('--project <name>', 'Filter by project')
  .option('--since <date>', 'Filter runs since date (ISO format)')
  .option('--until <date>', 'Filter runs until date (ISO format)')
  .action(async (opts: Record<string, unknown>) => {
    const anvilDirs = getFFDirs();
    const indexReader = new IndexReader(join(anvilDirs.runs, 'index.jsonl'));

    let runs: RunRecord[];
    try {
      runs = await indexReader.listRuns();
    } catch {
      runs = [];
    }

    if (runs.length === 0) {
      info('No run records found. Run your first feature with "ff run" to see stats.');
      return;
    }

    const stats = aggregateStats(runs, {
      project: opts.project as string | undefined,
      since: opts.since as string | undefined,
      until: opts.until as string | undefined,
    });

    const output = formatStats(stats);
    console.log(output);
  });
