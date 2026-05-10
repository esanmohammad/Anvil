// CLI command: anvil run-replay <run-id>
// Phase D5 — read the durable execution log for a run and render
// a vertical timeline of every step + effect to stdout.
//
// Reads from `~/.anvil/durable.db`. Read-only — does not mutate
// the run; the engine's resume path is `anvil resume <runId>`.

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { SQLiteDurableStore, type EventRecord } from '@esankhan3/anvil-core-pipeline';

function durableDbPath(): string {
  const env = process.env.ANVIL_HOME;
  return join(env ?? join(homedir(), '.anvil'), 'durable.db');
}

function colorForKind(kind: string): (s: string) => string {
  if (kind === 'step:started') return pc.cyan;
  if (kind === 'step:completed') return pc.green;
  if (kind === 'step:failed') return pc.red;
  if (kind === 'step:skipped') return pc.dim;
  if (kind === 'effect:started') return pc.blue;
  if (kind === 'effect:completed') return pc.bold;
  if (kind === 'effect:failed') return pc.red;
  if (kind.startsWith('signal')) return pc.magenta;
  return pc.white;
}

function summarisePayload(ev: EventRecord): string {
  if (ev.payload === null || ev.payload === undefined) return '';
  if (typeof ev.payload !== 'object') return String(ev.payload);
  const obj = ev.payload as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.idempotencyKey === 'string') return `key=${obj.idempotencyKey}`;
  if (typeof obj.version === 'number') return `v${obj.version}`;
  if (typeof obj.durationMs === 'number') return `${Math.round(obj.durationMs)}ms`;
  return JSON.stringify(obj).slice(0, 80);
}

export const runReplayCommand = new Command('run-replay')
  .description('Print the durable execution timeline for a run (read-only)')
  .argument('<run-id>', 'Run ID to inspect')
  .option('--from-seq <n>', 'Start from event seq (for tailing)')
  .option('--effects', 'Include effect:* events (default: step:* only)')
  .action(async (runId: string, opts: { fromSeq?: string; effects?: boolean }) => {
    const dbPath = durableDbPath();
    if (!existsSync(dbPath)) {
      console.error(pc.red(`No durable store at ${dbPath}; nothing to replay.`));
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
      console.log('');
      console.log(pc.bold(`Run: ${run.runId}`));
      console.log(`  Project:       ${run.project}`);
      console.log(`  Feature:       ${run.feature} (${run.featureSlug})`);
      console.log(`  Status:        ${run.status}`);
      console.log(`  Current step:  ${run.currentStep ?? '(none)'}`);
      console.log(`  Cursor seq:    ${run.cursorSeq}`);
      console.log(`  Workflow ver:  ${run.workflowVer}`);
      console.log(`  Started:       ${run.startedAt}`);
      console.log(`  Updated:       ${run.updatedAt}`);
      console.log(`  Lease:         ${run.leaseHolder ?? '(unleased)'}${run.leaseExpires ? ` until ${run.leaseExpires}` : ''}`);
      console.log('');

      const fromSeq = opts.fromSeq ? Number.parseInt(opts.fromSeq, 10) : 0;
      const events = await store.readEvents(runId, fromSeq);
      let lastStep: string | null = null;
      for (const ev of events) {
        const isEffect = ev.kind.startsWith('effect:');
        if (isEffect && !opts.effects) continue;
        if (ev.stepId && ev.stepId !== lastStep && !isEffect) {
          console.log('');
          lastStep = ev.stepId;
        }
        const seqStr = String(ev.seq).padStart(4, ' ');
        const kindStr = ev.kind.padEnd(20, ' ');
        const colour = colorForKind(ev.kind);
        const stepCol = ev.stepId ? pc.dim(`[${ev.stepId}]`) : '';
        const effectCol = ev.effectKey
          ? pc.dim(` <${ev.effectKey}#${ev.effectIdx ?? 0}>`)
          : '';
        const summary = summarisePayload(ev);
        console.log(`  ${pc.dim(seqStr)}  ${colour(kindStr)} ${stepCol}${effectCol}  ${summary ? pc.dim(summary) : ''}`);
      }
      console.log('');
      console.log(pc.dim(`${events.length} event(s)${opts.effects ? '' : ' (step:* only — pass --effects to include effect log)'}`));
      console.log('');
    } finally {
      await store.close();
    }
  });
