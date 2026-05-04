/**
 * `anvil cost` — show run cost summaries and respond to breach prompts.
 *
 * Mirrors incidents.ts: every subcommand connects to the dashboard over
 * WebSocket, resolves the project from --project or factory.yaml, and
 * surfaces actionable errors when the dashboard isn't running.
 *
 * Server endpoints (Phase 8 integration):
 *  - ws  get-cost-summary    → { type: 'cost-summary', payload: RunCostSummary }
 *  - ws  respond-cost-breach → { type: 'cost-breach-response', payload: { ok: true } }
 *  - http POST /api/cost/respond — non-WS fallback for CI / scripts
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { info, success, error } from '../logger.js';
import { getAnvilHome } from '../home.js';
import { connectDashboard, type DashboardClient } from '../lib/dashboard-ws.js';

// ── Types (narrow local mirrors of the dashboard-side types) ─────────────

type CostStage = 'plan' | 'implement' | 'review' | 'test' | 'ship' | 'other';

interface RunCostSummary {
  runId: string;
  project: string;
  totalUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  byStage: Record<CostStage, number>;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  startedAt?: string;
  lastAt?: string;
}

// ── Project resolution ───────────────────────────────────────────────────

function readProjectField(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const m = raw.match(/^\s*project:\s*["']?([^"'\r\n#]+)["']?\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function listConfiguredProjects(): string[] {
  const projectsDir = join(getAnvilHome(), 'projects');
  if (!existsSync(projectsDir)) return [];
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch { return []; }
}

function resolveProject(explicit?: string): string {
  if (explicit) return explicit;
  const cwd = process.cwd();
  const candidates = [
    join(cwd, 'factory.yaml'),
    join(cwd, 'anvil.yaml'),
    join(cwd, '.factory', 'config.yaml'),
    join(cwd, '.anvil', 'config.yaml'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const name = readProjectField(path);
    if (name) return name;
  }
  const projects = listConfiguredProjects();
  if (projects.length === 1) return projects[0];
  if (projects.length === 0) {
    error('No project specified and no factory.yaml/anvil.yaml in the current directory.');
  } else {
    error('Multiple projects configured — please pass --project <name>.');
  }
  process.exit(1);
}

// ── Rendering helpers ────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.0000';
  return `$${n.toFixed(4)}`;
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

function renderSummary(summary: RunCostSummary): void {
  console.log(pc.bold(`Run ${summary.runId} (${summary.project})`));
  console.log(`  Total:        ${pc.green(fmtUsd(summary.totalUsd))}`);
  console.log(`  Tokens in:    ${summary.totalTokensIn.toLocaleString()}`);
  console.log(`  Tokens out:   ${summary.totalTokensOut.toLocaleString()}`);
  if (summary.startedAt) console.log(`  Started:      ${summary.startedAt.slice(0, 19).replace('T', ' ')}`);
  if (summary.lastAt) console.log(`  Last entry:   ${summary.lastAt.slice(0, 19).replace('T', ' ')}`);
  console.log('');

  const byStage = Object.entries(summary.byStage).filter(([, v]) => v > 0);
  if (byStage.length) {
    console.log(pc.bold('By stage'));
    fmtTable(['STAGE', 'USD'], byStage.map(([k, v]) => [k, fmtUsd(v)]));
    console.log('');
  }

  const byModel = Object.entries(summary.byModel);
  if (byModel.length) {
    console.log(pc.bold('By model'));
    fmtTable(['MODEL', 'USD'], byModel.map(([k, v]) => [k, fmtUsd(v)]));
    console.log('');
  }

  const byAgent = Object.entries(summary.byAgent);
  if (byAgent.length) {
    console.log(pc.bold('By agent'));
    fmtTable(['AGENT', 'USD'], byAgent.map(([k, v]) => [k, fmtUsd(v)]));
  }
}

// ── Subcommand: anvil cost show ──────────────────────────────────────────

const showCmd = new Command('show')
  .description('Show cost summary for a project and/or run')
  .option('--project <name>', 'Project name')
  .option('--run <id>', 'Run id')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const runId = opts.run;
    if (!runId) {
      error('Please pass --run <id> to show a summary.');
      process.exitCode = 1;
      return;
    }
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ summary: RunCostSummary }>(
        { action: 'get-cost-summary', project, runId },
        { resolveOn: ['cost-summary'], rejectOn: ['error'] },
      );
      if (!payload?.summary) {
        error(`No cost data for ${project}/${runId}.`);
        process.exitCode = 1;
        return;
      }
      renderSummary(payload.summary);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil cost raise ─────────────────────────────────────────

const raiseCmd = new Command('raise')
  .description('Approve an additional USD delta on a breached run')
  .argument('<runId>', 'Run id with a pending breach')
  .requiredOption('--delta <usd>', 'Amount of USD to approve')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (runId: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const delta = Number.parseFloat(opts.delta || '');
    if (!Number.isFinite(delta) || delta <= 0) {
      error(`--delta must be a positive number (got ${opts.delta ?? 'nothing'}).`);
      process.exitCode = 1;
      return;
    }
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Raising limit on ${runId} by ${pc.green(`$${delta.toFixed(2)}`)}...`);
      await client.request(
        {
          action: 'respond-cost-breach',
          project,
          runId,
          decision: 'raise',
          deltaUsd: delta,
        },
        { resolveOn: ['cost-breach-response'], rejectOn: ['error'] },
      );
      success(`Raise approved. Run continues.`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil cost reject ────────────────────────────────────────

const rejectCmd = new Command('reject')
  .description('Reject a breached run and stop it (checkpoint via Phase 9)')
  .argument('<runId>', 'Run id with a pending breach')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (runId: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Rejecting run ${pc.red(runId)} — checkpointing and stopping...`);
      await client.request(
        {
          action: 'respond-cost-breach',
          project,
          runId,
          decision: 'reject',
        },
        { resolveOn: ['cost-breach-response'], rejectOn: ['error'] },
      );
      success('Run rejected. Checkpoint flushed.');
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Command group ───────────────────────────────────────────────────────

export const costCommand = new Command('cost')
  .description('Inspect run cost and respond to breach prompts')
  .addCommand(showCmd)
  .addCommand(raiseCmd)
  .addCommand(rejectCmd);
