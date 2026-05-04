/**
 * `anvil-loc checkpoints` — inspect and maintain the on-disk checkpoint
 * cache introduced in Phase 9.
 *
 * Subcommands:
 *   - stats       show hit-rate and cost-saved for a project / run
 *   - invalidate  delete records for a run+stage (blobs stay — they're
 *                 content-addressed and shared; use `gc` for those)
 *   - gc          delete orphan blobs not referenced by any record
 *
 * This command reads the local `$ANVIL_HOME/checkpoints/` tree directly. It
 * does not talk to the dashboard over WebSocket because checkpoint files
 * are plain JSON and the user can run this offline (e.g. to recover disk
 * after a large run). Types are duplicated from the dashboard package to
 * keep the CLI free of runtime imports from server code (see
 * `incident-stats-formatter.ts` header for the rationale).
 */

import { Command } from 'commander';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';

import { getAnvilHome } from '../home.js';
import { error, info, success, warn } from '../logger.js';

// ── Types (duplicated from packages/dashboard/server/checkpoint-types.ts) ─

type CheckpointStage =
  | 'plan'
  | 'implement'
  | 'review'
  | 'test'
  | 'ship'
  | 'kb-grounding'
  | 'mutation';

type CheckpointStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed';

interface CheckpointKey {
  hash: string;
  runFamily: string;
  stage: CheckpointStage;
  taskId: string;
}

interface CheckpointRecord {
  key: CheckpointKey;
  project: string;
  status: CheckpointStatus;
  outputRef?: string;
  cost?: { usd: number; tokensIn: number; tokensOut: number };
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  errorMessage?: string;
}

const STAGES: CheckpointStage[] = [
  'plan',
  'implement',
  'review',
  'test',
  'ship',
  'kb-grounding',
  'mutation',
];

// ── Filesystem helpers ───────────────────────────────────────────────────

function checkpointsRoot(): string {
  return join(getAnvilHome(), 'checkpoints');
}

function blobsRoot(): string {
  return join(checkpointsRoot(), '_blobs');
}

function readRecordSafe(path: string): CheckpointRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CheckpointRecord;
  } catch {
    return null;
  }
}

function listProjects(): string[] {
  const root = checkpointsRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listRuns(project: string): string[] {
  const dir = join(checkpointsRoot(), project);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listRecords(project: string, run: string): CheckpointRecord[] {
  const runDir = join(checkpointsRoot(), project, run);
  if (!existsSync(runDir)) return [];
  const out: CheckpointRecord[] = [];
  for (const stage of STAGES) {
    const stageDir = join(runDir, stage);
    if (!existsSync(stageDir)) continue;
    let files: string[];
    try {
      files = readdirSync(stageDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const rec = readRecordSafe(join(stageDir, f));
      if (rec) out.push(rec);
    }
  }
  return out;
}

function fmtTable(header: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  console.log(pc.bold(fmtRow(header)));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(fmtRow(row));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

// ── Subcommand: stats ────────────────────────────────────────────────────

const statsCmd = new Command('stats')
  .description('Show checkpoint cache hit-rate and cost-saved for a project / run')
  .option('--project <slug>', 'Project to inspect')
  .option('--run <id>', 'Run family id')
  .action((opts: { project?: string; run?: string }) => {
    const projects = opts.project ? [opts.project] : listProjects();
    if (projects.length === 0) {
      info('No checkpoints recorded yet.');
      return;
    }
    const rows: string[][] = [];
    let grandTotal = 0;
    let grandCompleted = 0;
    let grandInterrupted = 0;
    let grandFailed = 0;
    let grandCostSaved = 0;
    for (const project of projects) {
      const runs = opts.run ? [opts.run] : listRuns(project);
      for (const run of runs) {
        const records = listRecords(project, run);
        if (records.length === 0) continue;
        const completed = records.filter((r) => r.status === 'completed').length;
        const interrupted = records.filter((r) => r.status === 'interrupted').length;
        const failed = records.filter((r) => r.status === 'failed').length;
        const running = records.filter((r) => r.status === 'running').length;
        const costSaved = records
          .filter((r) => r.status === 'completed')
          .reduce((acc, r) => acc + (r.cost?.usd ?? 0), 0);
        grandTotal += records.length;
        grandCompleted += completed;
        grandInterrupted += interrupted;
        grandFailed += failed;
        grandCostSaved += costSaved;
        rows.push([
          project,
          run,
          String(records.length),
          pc.green(String(completed)),
          pc.yellow(String(interrupted)),
          pc.red(String(failed)),
          pc.dim(String(running)),
          `$${costSaved.toFixed(3)}`,
        ]);
      }
    }
    if (rows.length === 0) {
      info('No checkpoints matched your filters.');
      return;
    }
    fmtTable(
      ['PROJECT', 'RUN', 'TOTAL', 'COMPLETED', 'INTERRUPTED', 'FAILED', 'RUNNING', 'COST SAVED'],
      rows,
    );
    console.log('');
    const reuseRate = grandTotal === 0 ? 0 : grandCompleted / grandTotal;
    console.log(pc.bold('Summary'));
    console.log(`  Records:      ${grandTotal}`);
    console.log(`  Completed:    ${grandCompleted} (${(reuseRate * 100).toFixed(1)}%)`);
    console.log(`  Interrupted:  ${grandInterrupted}`);
    console.log(`  Failed:       ${grandFailed}`);
    console.log(`  Cost saved:   $${grandCostSaved.toFixed(3)}  ${pc.dim('(sum of completed.cost.usd — approx reuse value)')}`);
  });

// ── Subcommand: invalidate ───────────────────────────────────────────────

const invalidateCmd = new Command('invalidate')
  .description('Delete checkpoint records for a run+stage (blobs are NOT removed — use gc)')
  .requiredOption('--run <id>', 'Run family id')
  .requiredOption('--stage <stage>', 'Stage (plan|implement|review|test|ship|kb-grounding|mutation)')
  .option('--project <slug>', 'Project slug (required if more than one project has the run)')
  .action((opts: { run: string; stage: string; project?: string }) => {
    if (!(STAGES as string[]).includes(opts.stage)) {
      error(`Unknown stage: ${opts.stage}`);
      error(`Valid stages: ${STAGES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const stage = opts.stage as CheckpointStage;
    const projects = opts.project ? [opts.project] : listProjects();
    let totalDeleted = 0;
    for (const project of projects) {
      const stageDir = join(checkpointsRoot(), project, opts.run, stage);
      if (!existsSync(stageDir)) continue;
      let files: string[];
      try {
        files = readdirSync(stageDir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          unlinkSync(join(stageDir, f));
          totalDeleted += 1;
        } catch (err) {
          warn(`Failed to delete ${f}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (totalDeleted === 0) {
      info(`No records to invalidate for run=${opts.run} stage=${stage}.`);
      return;
    }
    success(`Invalidated ${totalDeleted} record(s). Blobs preserved (run \`anvil-loc checkpoints gc\` to clean orphans).`);
  });

// ── Subcommand: gc ───────────────────────────────────────────────────────

function parseOlderThan(spec: string | undefined): number {
  if (!spec) return 0;
  const m = spec.match(/^(\d+)\s*([dhm])$/i);
  if (!m) {
    error(`Invalid --older-than value: ${spec} (expected e.g. 7d, 24h, 30m)`);
    process.exit(1);
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  return n * mult;
}

const gcCmd = new Command('gc')
  .description('Delete orphan blobs not referenced by any checkpoint record')
  .option('--older-than <spec>', 'Only remove blobs older than N days/hours/minutes (e.g. 7d, 24h). Default: 0 (all orphans).', '0d')
  .action((opts: { olderThan?: string }) => {
    const thresholdMs = parseOlderThan(opts.olderThan);
    const referenced = new Set<string>();

    // Walk every record under checkpoints/<project>/<run>/<stage>/*.json.
    for (const project of listProjects()) {
      for (const run of listRuns(project)) {
        for (const rec of listRecords(project, run)) {
          if (rec.outputRef) referenced.add(rec.outputRef);
        }
      }
    }

    const root = blobsRoot();
    if (!existsSync(root)) {
      info('No blob store present — nothing to collect.');
      return;
    }

    let prefixes: string[];
    try {
      prefixes = readdirSync(root);
    } catch {
      info('Blob store unreadable — nothing to collect.');
      return;
    }

    let deleted = 0;
    let bytes = 0;
    const now = Date.now();

    for (const prefix of prefixes) {
      const prefixDir = join(root, prefix);
      let entries: string[];
      try {
        entries = readdirSync(prefixDir);
      } catch {
        continue;
      }
      for (const sha of entries) {
        if (referenced.has(sha)) continue;
        const file = join(prefixDir, sha);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (thresholdMs > 0 && now - st.mtimeMs < thresholdMs) continue;
        try {
          unlinkSync(file);
          deleted += 1;
          bytes += st.size;
        } catch (err) {
          warn(`Failed to delete blob ${sha}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    success(`Deleted ${deleted} orphan blob(s); freed ${fmtBytes(bytes)}.`);
  });

// ── Command group ────────────────────────────────────────────────────────

export const checkpointsCommand = new Command('checkpoints')
  .description('Inspect and maintain the deterministic agent-checkpoint cache')
  .addCommand(statsCmd)
  .addCommand(invalidateCmd)
  .addCommand(gcCmd);
