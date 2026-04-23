/**
 * `anvil plan` — command group for the structured Plan feature.
 *
 * All subcommands talk to a running `anvil dashboard` over WebSocket. They
 * resolve the active project from --project, ./factory.yaml, or ./anvil.yaml,
 * and exit with actionable error messages when the dashboard isn't running.
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { info, success, warn, error } from '../logger.js';
import { getAnvilHome } from '../home.js';
import { connectDashboard, type DashboardClient, type DashboardMessage } from '../lib/dashboard-ws.js';

// ── Types (narrow local mirrors of the dashboard-side types) ─────────────

interface PlanPointer {
  slug: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}

interface PlanEstimate { usd: number; minutes: number; prs: number }

interface Plan {
  version: number;
  slug: string;
  project: string;
  title: string;
  problem: string;
  scope: { inScope: string[]; outOfScope: string[] };
  repos: Array<{ name: string; changes: string; files: string[]; symbols: string[] }>;
  contracts: Array<{ kind: string; name: string; producer: string; consumers: string[]; description: string }>;
  architecture: { mermaid: string; notes: string };
  risks: Array<{ title: string; mitigation: string; severity: string }>;
  rollout: { strategy: string; flags: string[]; order: string[]; rollback: string };
  tests: { unit: string[]; integration: string[]; manual: string[] };
  estimate: PlanEstimate;
  model: string;
  feature: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanIssue { severity: 'error' | 'warn' | 'info'; path: string; message: string; hint?: string; repo?: string }
interface PlanValidation {
  generatedAt: string;
  planVersion: number;
  issues: PlanIssue[];
  counts: { errors: number; warnings: number; infos: number };
}

// ── Project resolution ──────────────────────────────────────────────────

/** Parse a `project:` value out of a YAML-ish config file. */
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
      .map((d) => d.name)
      .filter((name) => existsSync(join(projectsDir, name, 'factory.yaml'))
        || existsSync(join(projectsDir, name, 'project.yaml')));
  } catch { return []; }
}

/**
 * Resolve the project name from CLI opts or the working directory.
 * - --project flag wins.
 * - Otherwise: ./factory.yaml → ./anvil.yaml → ./.factory/config.yaml.
 * - If none found and multiple projects are configured, exit with a list.
 */
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

  // No local hint — fall back to the single configured project, if unambiguous.
  const projects = listConfiguredProjects();
  if (projects.length === 1) return projects[0];

  if (projects.length === 0) {
    error('No project specified and no factory.yaml/anvil.yaml in the current directory.');
    error('Pass --project <name> or run `anvil init` to scaffold one.');
  } else {
    error('Multiple projects configured — please pass --project <name>.');
    for (const p of projects) error(`  - ${p}`);
  }
  process.exit(1);
}

// ── `--from-issue` helper ────────────────────────────────────────────────

function fetchIssueViaGh(url: string): { title: string; body: string; labels: string[] } {
  try {
    const out = execSync(`gh issue view ${JSON.stringify(url)} --json title,body,labels`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    const parsed = JSON.parse(out) as { title?: string; body?: string; labels?: Array<{ name?: string } | string> };
    return {
      title: parsed.title ?? '',
      body: parsed.body ?? '',
      labels: (parsed.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to fetch issue via gh: ${msg}`);
    error('Check that `gh` is installed, authenticated, and the URL is correct.');
    process.exit(1);
  }
}

// ── Markdown rendering (minimal reimplementation of PlanStore.renderMarkdown) ──

function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push(`> Plan v${plan.version} — ${plan.project} — ${plan.model}`);
  lines.push('');

  lines.push('## Problem');
  lines.push(plan.problem || '_No problem statement._');
  lines.push('');

  lines.push('## Scope');
  if (plan.scope.inScope.length) {
    lines.push('**In scope**');
    for (const s of plan.scope.inScope) lines.push(`- ${s}`);
  }
  if (plan.scope.outOfScope.length) {
    lines.push('');
    lines.push('**Out of scope**');
    for (const s of plan.scope.outOfScope) lines.push(`- ${s}`);
  }
  lines.push('');

  if (plan.repos.length) {
    lines.push('## Affected repositories');
    for (const r of plan.repos) {
      lines.push(`### ${r.name}`);
      if (r.changes) lines.push(r.changes);
      if (r.files.length) lines.push(`**Files:** ${r.files.map((f) => `\`${f}\``).join(', ')}`);
      if (r.symbols.length) lines.push(`**Symbols:** ${r.symbols.map((s) => `\`${s}\``).join(', ')}`);
      lines.push('');
    }
  }

  if (plan.contracts.length) {
    lines.push('## Cross-repo contracts');
    for (const c of plan.contracts) {
      lines.push(`- **${c.kind.toUpperCase()} · ${c.name}** — ${c.producer} → ${c.consumers.join(', ') || '(none)'}`);
      if (c.description) lines.push(`  ${c.description}`);
    }
    lines.push('');
  }

  if (plan.architecture.notes || plan.architecture.mermaid) {
    lines.push('## Architecture');
    if (plan.architecture.notes) { lines.push(plan.architecture.notes); lines.push(''); }
    if (plan.architecture.mermaid) {
      lines.push('```mermaid');
      lines.push(plan.architecture.mermaid);
      lines.push('```');
      lines.push('');
    }
  }

  if (plan.risks.length) {
    lines.push('## Risks');
    for (const r of plan.risks) lines.push(`- **[${r.severity}] ${r.title}** — ${r.mitigation}`);
    lines.push('');
  }

  lines.push('## Rollout');
  if (plan.rollout.strategy) lines.push(plan.rollout.strategy);
  if (plan.rollout.flags.length) lines.push(`- Flags: ${plan.rollout.flags.join(', ')}`);
  if (plan.rollout.order.length) lines.push(`- Order: ${plan.rollout.order.join(' → ')}`);
  if (plan.rollout.rollback) lines.push(`- Rollback: ${plan.rollout.rollback}`);
  lines.push('');

  lines.push('## Tests');
  if (plan.tests.unit.length) {
    lines.push('**Unit**');
    for (const t of plan.tests.unit) lines.push(`- ${t}`);
  }
  if (plan.tests.integration.length) {
    lines.push('**Integration**');
    for (const t of plan.tests.integration) lines.push(`- ${t}`);
  }
  if (plan.tests.manual.length) {
    lines.push('**Manual**');
    for (const t of plan.tests.manual) lines.push(`- ${t}`);
  }
  lines.push('');

  lines.push('## Estimate');
  lines.push(`- ~$${plan.estimate.usd.toFixed(2)} · ${plan.estimate.minutes} min · ${plan.estimate.prs} PR(s)`);

  return lines.join('\n') + '\n';
}

// ── Agent-output streaming ───────────────────────────────────────────────

/** Extract a short text snippet from an agent-output broadcast. */
function streamAgentOutput(msg: DashboardMessage): void {
  if (msg.type !== 'agent-output') return;
  const payload = msg.payload as { entries?: Array<{ content?: string; summary?: string; kind?: string }> } | undefined;
  const entries = payload?.entries;
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const text = (entry.content || entry.summary || '').trim();
    if (!text) continue;
    // Keep it readable — cap each broadcast at 4 lines.
    const lines = text.split(/\r?\n/).slice(0, 4);
    for (const line of lines) process.stdout.write(`  ${pc.dim('│')} ${line}\n`);
  }
}

// ── Subcommand: plan new ────────────────────────────────────────────────

const newCmd = new Command('new')
  .description('Generate a new plan for a feature (requires `anvil dashboard` running)')
  .argument('<feature>', 'Feature description')
  .option('--project <name>', 'Project name (defaults to factory.yaml in cwd)')
  .option('--model <id>', 'Model id to use for planning')
  .option('--from-issue <url>', 'Prepend the title + body of a GitHub issue (uses `gh`)')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (feature: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let fullFeature = feature;
    if (opts.fromIssue) {
      info(`Fetching issue ${opts.fromIssue}...`);
      const issue = fetchIssueViaGh(opts.fromIssue);
      fullFeature = `# ${issue.title}\n\n${issue.body}\n\n---\n\n${feature}`;
      if (issue.labels.length) info(`Labels: ${issue.labels.join(', ')}`);
    }

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Connected to dashboard at ${client.url}`);
      info(`Planning "${pc.bold(project)}"...`);
      console.error('');

      const result = await client.request<{ plan: Plan; validation: PlanValidation | null }>(
        { action: 'run-plan', project, feature: fullFeature, options: { model: opts.model } },
        {
          resolveOn: ['plan-created'],
          rejectOn: ['error', 'plan-error'],
          onMessage: streamAgentOutput,
          timeoutMs: 10 * 60_000,
        },
      );

      const { plan, validation } = result.payload;
      console.error('');
      success(`Plan created: ${pc.bold(plan.title)}`);
      console.error(`  slug:    ${plan.slug}`);
      console.error(`  version: v${plan.version}`);
      console.error(`  repos:   ${plan.repos.length}`);
      console.error(`  cost:    ~$${plan.estimate.usd.toFixed(2)} · ${plan.estimate.minutes} min · ${plan.estimate.prs} PR(s)`);
      if (validation) {
        const { errors, warnings, infos } = validation.counts;
        console.error(`  lint:    ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`);
      }
      console.error('');
      info(`View: ${pc.cyan(`anvil plan show ${plan.slug} --project ${project}`)}`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: plan show ───────────────────────────────────────────────

const showCmd = new Command('show')
  .description('Show a plan in markdown or JSON')
  .argument('<slug>', 'Plan slug')
  .option('--project <name>', 'Project name')
  .option('--format <fmt>', 'Output format: md or json', 'md')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (slug: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);
    const format = (opts.format || 'md').toLowerCase();

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ plan: Plan | null; validation: PlanValidation | null }>(
        { action: 'get-plan', project, planSlug: slug },
        { resolveOn: ['plan'], rejectOn: ['error'] },
      );

      if (!payload.plan) {
        error(`Plan not found: ${project}/${slug}`);
        process.exitCode = 1;
        return;
      }

      if (format === 'json') {
        process.stdout.write(JSON.stringify(payload.plan, null, 2) + '\n');
      } else if (format === 'md' || format === 'markdown') {
        process.stdout.write(renderPlanMarkdown(payload.plan));
      } else {
        error(`Unknown format: ${format}. Use md or json.`);
        process.exitCode = 1;
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: plan list ───────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List plans for a project')
  .option('--project <name>', 'Project name (omit to list all)')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    // `list` is tolerant of an unset project: the server accepts undefined.
    const project = opts.project ?? (() => {
      try { return resolveProject(undefined); } catch { return undefined; }
    })();
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ plans: PlanPointer[] }>(
        { action: 'get-plans', project },
        { resolveOn: ['plans'], rejectOn: ['error'] },
      );

      const plans = payload.plans ?? [];
      if (plans.length === 0) {
        info(project ? `No plans for project "${project}".` : 'No plans found.');
        return;
      }

      // Table: slug | title | version | updatedAt
      const header = ['SLUG', 'TITLE', 'VERSION', 'UPDATED'];
      const rows = plans.map((p) => [
        p.slug,
        p.title.length > 50 ? p.title.slice(0, 47) + '...' : p.title,
        `v${p.currentVersion}`,
        p.updatedAt.slice(0, 16).replace('T', ' '),
      ]);
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

      const fmtRow = (cells: string[]): string =>
        cells.map((c, i) => c.padEnd(widths[i])).join('  ');

      console.log(pc.bold(fmtRow(header)));
      console.log(widths.map((w) => '─'.repeat(w)).join('  '));
      for (const row of rows) console.log(fmtRow(row));
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: plan validate ───────────────────────────────────────────

const validateCmd = new Command('validate')
  .description('Validate a plan. Exits non-zero if errors are found (CI-friendly).')
  .argument('<slug>', 'Plan slug')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (slug: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ validation: PlanValidation; planSlug: string }>(
        { action: 'validate-plan', project, planSlug: slug },
        {
          resolveOn: ['plan-validation'],
          rejectOn: ['error'],
          filter: (m) => {
            const p = m.payload as { planSlug?: string } | undefined;
            return !p?.planSlug || p.planSlug === slug;
          },
        },
      );

      const { errors, warnings, infos } = payload.validation.counts;
      console.log(pc.bold(`Validation for ${project}/${slug} (v${payload.validation.planVersion})`));
      console.log(`  ${errors > 0 ? pc.red(`${errors} errors`) : pc.green(`${errors} errors`)}, ${pc.yellow(`${warnings} warnings`)}, ${pc.dim(`${infos} infos`)}`);

      if (payload.validation.issues.length) {
        console.log('');
        for (const issue of payload.validation.issues) {
          const color = issue.severity === 'error' ? pc.red : issue.severity === 'warn' ? pc.yellow : pc.dim;
          console.log(`  ${color(`[${issue.severity}]`)} ${issue.path}: ${issue.message}`);
          if (issue.hint) console.log(`    ${pc.dim('hint:')} ${issue.hint}`);
        }
      }

      if (errors > 0) process.exitCode = 1;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: plan execute ────────────────────────────────────────────

const executeCmd = new Command('execute')
  .description('Hand a plan to the pipeline. Blocked by validation errors unless --force.')
  .argument('<slug>', 'Plan slug')
  .option('--project <name>', 'Project name')
  .option('--force', 'Execute even when validation errors exist', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (slug: string, opts: Record<string, string | boolean | undefined>) => {
    const project = resolveProject(opts.project as string | undefined);
    const port = parseInt((opts.port as string) || '5173', 10);
    const force = !!opts.force;

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });

      const { type, payload } = await client.request<
        | { planSlug: string }
        | { validation: PlanValidation; blocked: boolean; message: string; planSlug: string }
      >(
        { action: 'execute-plan', project, planSlug: slug, force },
        {
          resolveOn: ['plan-execute-started', 'plan-validation'],
          rejectOn: ['error'],
          filter: (m) => {
            const p = m.payload as { planSlug?: string } | undefined;
            return !p?.planSlug || p.planSlug === slug;
          },
        },
      );

      if (type === 'plan-execute-started') {
        success(`Pipeline started — watch at ${pc.cyan(`http://localhost:${port}/#/runs`)}`);
        return;
      }

      // plan-validation response with blocked=true means the server refused.
      const p = payload as { validation?: PlanValidation; blocked?: boolean; message?: string };
      if (p.blocked && p.validation) {
        warn(p.message || 'Plan execution blocked by validation errors.');
        for (const issue of p.validation.issues.filter((i) => i.severity === 'error')) {
          console.error(`  ${pc.red('[error]')} ${issue.path}: ${issue.message}`);
          if (issue.hint) console.error(`    ${pc.dim('hint:')} ${issue.hint}`);
        }
        console.error('');
        info(`Fix the errors, or re-run with ${pc.cyan('--force')} to execute anyway.`);
        process.exitCode = 1;
      } else {
        warn('Unexpected response from server:');
        console.error(JSON.stringify(p, null, 2));
        process.exitCode = 1;
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Command group ───────────────────────────────────────────────────────

export const planCommand = new Command('plan')
  .description('Generate, inspect, validate, and execute structured plans')
  .addCommand(newCmd)
  .addCommand(showCmd)
  .addCommand(listCmd)
  .addCommand(validateCmd)
  .addCommand(executeCmd);
