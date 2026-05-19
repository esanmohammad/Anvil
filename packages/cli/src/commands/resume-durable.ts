// CLI command: anvil resume-durable <run-id>
// Phase F5 — durable-execution-aware resume.
//
// Opens ~/.anvil/durable.db, looks up the run row, and prints
// resume status. Two paths:
//
//   1. Run already has a live lease (another process owns it):
//      print holder + remaining ttl; exit non-zero.
//   2. Run lease is expired or absent: try to take it over.
//      On success, mark `running` and emit a `run:status` event
//      with reason='cli-resume-request'. The dashboard's auto-
//      takeover scanner picks up runs in this state on its next
//      sweep; user is told to start the dashboard if it isn't
//      running.
//
// Read-only by default (no --take). Pass `--take` to acquire the
// lease + mark resume-requested.
//
// This command DOES NOT invoke Pipeline.run() — the dashboard's
// pipeline runner owns that. The CLI is the resume *request*
// surface; the dashboard is the resume *executor*. The legacy
// `anvil resume <run-id>` command (using the run-store) stays
// available for runs that pre-date durable execution.

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import pc from 'picocolors';
import {
  SQLiteDurableStore,
  tryTakeOverLease,
  type RunRecord,
} from '@esankhan3/anvil-core-pipeline';

function durableDbPath(): string {
  const env = process.env.ANVIL_HOME;
  return join(env ?? join(homedir(), '.anvil'), 'durable.db');
}

function holderId(): string {
  return `${process.pid}@${hostname()}-anvil-cli`;
}

function fmtRemaining(expiresIso: string | null, now: number): string {
  if (!expiresIso) return 'no lease';
  const expiresMs = Date.parse(expiresIso);
  if (!Number.isFinite(expiresMs)) return 'invalid lease';
  const ms = expiresMs - now;
  if (ms <= 0) return 'expired';
  return `${Math.round(ms / 1000)}s remaining`;
}

function renderRun(run: RunRecord): void {
  console.log('');
  console.log(pc.bold(`Run: ${run.runId}`));
  console.log(`  Project:       ${run.project}`);
  console.log(`  Feature:       ${run.feature} (${run.featureSlug})`);
  console.log(`  Status:        ${run.status}`);
  console.log(`  Current step:  ${run.currentStep ?? '(none)'}`);
  console.log(`  Cursor seq:    ${run.cursorSeq}`);
  console.log(`  Lease:         ${run.leaseHolder ?? '(unleased)'} (${fmtRemaining(run.leaseExpires, Date.now())})`);
  console.log(`  Started:       ${run.startedAt}`);
  console.log(`  Updated:       ${run.updatedAt}`);
  console.log('');
}

export const resumeDurableCommand = new Command('resume-durable')
  .description('Resume a durable pipeline run from its last checkpoint (read-only without --take)')
  .argument('<run-id>', 'Run ID to resume')
  .option('--take', 'Acquire the lease + mark resume-requested. Without this flag, runs read-only.')
  .option('--force', 'Take over a live lease (use only when the prior process is dead)')
  .option('--ttl <ms>', 'Lease ttl in ms when --take', '60000')
  .action(async (
    runId: string,
    opts: { take?: boolean; force?: boolean; ttl?: string },
  ) => {
    const dbPath = durableDbPath();
    if (!existsSync(dbPath)) {
      console.error(pc.red(`No durable store at ${dbPath}; nothing to resume.`));
      process.exitCode = 1;
      return;
    }
    const store = new SQLiteDurableStore({ path: dbPath });
    try {
      const run = await store.getRun(runId);
      if (!run) {
        console.error(pc.red(`Run "${runId}" not found in ${dbPath}.`));
        process.exitCode = 1;
        return;
      }

      renderRun(run);

      if (run.status === 'completed') {
        console.log(pc.dim('Run is already completed; nothing to resume.'));
        return;
      }
      if (run.status === 'cancelled' || run.status === 'failed') {
        console.log(pc.yellow('Run is in a terminal state. Use `anvil run-replay <id>` to inspect; rerun from-stage in the dashboard.'));
      }

      if (!opts.take) {
        console.log(pc.dim('Read-only mode. Pass --take to acquire the lease + signal resume.'));
        return;
      }

      const ttlMs = Number.parseInt(opts.ttl ?? '60000', 10);
      const liveExpiry = run.leaseExpires ? Date.parse(run.leaseExpires) : 0;
      const isLive = liveExpiry > Date.now();
      if (isLive && !opts.force) {
        console.error(pc.red(`Run is leased by ${run.leaseHolder} (${fmtRemaining(run.leaseExpires, Date.now())}). Pass --force only if you know the prior process is dead.`));
        process.exitCode = 1;
        return;
      }

      const holder = holderId();
      const won = await tryTakeOverLease(store, runId, holder, ttlMs);
      if (!won) {
        console.error(pc.red('Lease takeover failed — a peer raced + won. Try again in a few seconds.'));
        process.exitCode = 1;
        return;
      }
      await store.appendEvent({
        runId,
        kind: 'run:status',
        payload: { reason: 'cli-resume-request', holder },
      });
      if (run.status !== 'running') {
        await store.updateRunStatus(runId, 'running', run.currentStep);
      }
      console.log(pc.green(`Lease acquired by ${holder} (${ttlMs}ms ttl).`));
      console.log(pc.dim('Start the dashboard (`anvil dashboard`) — its auto-takeover scanner will pick up this run and replay from its cursor.'));
    } finally {
      await store.close();
    }
  });
