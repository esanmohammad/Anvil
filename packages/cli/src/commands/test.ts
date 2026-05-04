/**
 * `anvil test` — command group for the Test Generation feature.
 *
 * All subcommands talk to a running `anvil dashboard` over WebSocket. They
 * resolve the active project from --project, ./factory.yaml, or ./anvil.yaml,
 * and exit with actionable error messages when the dashboard isn't running.
 *
 * Mirrors the pattern established by `plan.ts` and `review.ts`.
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { info, success, warn, error } from '../logger.js';
import { getAnvilHome } from '../home.js';
import { connectDashboard, type DashboardClient, type DashboardMessage } from '../lib/dashboard-ws.js';

// ── Types (narrow local mirrors of the dashboard-side types) ─────────────

type TestLevel = 'unit' | 'integration' | 'e2e';
type TestSeverity = 'blocker' | 'error' | 'warn' | 'info' | 'nit';
type TestFindingCategory = 'coverage' | 'edge-case' | 'security' | 'perf' | 'flakiness' | 'convention';

interface Behavior {
  id: string;
  description: string;
  level: TestLevel;
  expected?: string;
  preconditions?: string[];
  inputs?: Record<string, unknown>;
  tags?: string[];
}

interface TestFinding {
  severity: TestSeverity;
  category: TestFindingCategory;
  behaviorId?: string | null;
  caseId?: string | null;
  file?: string | null;
  line?: number;
  description: string;
  suggestedFix?: { diff: string; rationale: string } | null;
  confidence?: 'high' | 'med' | 'low';
}

interface TestSpecPointer {
  slug: string;
  title: string;
  project: string;
  planSlug?: string;
  behaviorCount: number;
  updatedAt: string;
}

interface TestSpec {
  slug: string;
  project: string;
  title: string;
  planSlug?: string;
  behaviors: Behavior[];
  findings?: TestFinding[];
  model?: string;
  createdAt: string;
  updatedAt: string;
}

interface TestCase {
  caseId: string;
  behaviorId: string;
  file: string;
  source: string;
  runner?: string;
}

interface ConventionFingerprint {
  runner: string;
  assertionStyle: string;
  fileLayout: string;
  namingPattern: string;
  setupPattern?: string;
  mockStyle?: string;
  fixtureStyle?: string;
  imports: Record<string, string>;
  examples: string[];
}

interface TestRunPointer {
  runId: string;
  slug: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error';
  startedAt?: string;
}

// ── Project resolution (mirrors plan.ts/review.ts) ───────────────────────

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
    error('Pass --project <name> or run `anvil init` to scaffold one.');
  } else {
    error('Multiple projects configured — please pass --project <name>.');
    for (const p of projects) error(`  - ${p}`);
  }
  process.exit(1);
}

// ── Agent-output streaming (to stderr so stdout stays parseable) ─────────

function streamAgentOutput(msg: DashboardMessage): void {
  if (msg.type !== 'agent-output') return;
  const payload = msg.payload as { entries?: Array<{ content?: string; summary?: string; kind?: string }> } | undefined;
  const entries = payload?.entries;
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const text = (entry.content || entry.summary || '').trim();
    if (!text) continue;
    const lines = text.split(/\r?\n/).slice(0, 4);
    for (const line of lines) process.stderr.write(`  ${pc.dim('│')} ${line}\n`);
  }
}

// ── Rendering helpers ────────────────────────────────────────────────────

function colorForSeverity(severity: TestSeverity): (s: string) => string {
  switch (severity) {
    case 'blocker':
    case 'error': return pc.red;
    case 'warn': return pc.yellow;
    case 'info': return pc.blue;
    case 'nit': return pc.dim;
    default: return (s) => s;
  }
}

function colorForLevel(level: TestLevel): (s: string) => string {
  switch (level) {
    case 'unit': return pc.green;
    case 'integration': return pc.cyan;
    case 'e2e': return pc.magenta;
    default: return (s) => s;
  }
}

function colorForStatus(status: TestRunPointer['status']): (s: string) => string {
  switch (status) {
    case 'passed': return pc.green;
    case 'failed':
    case 'error': return pc.red;
    case 'running': return pc.cyan;
    case 'queued': return pc.dim;
    default: return (s) => s;
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
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

function printFindings(findings: TestFinding[]): void {
  if (findings.length === 0) {
    console.log(pc.dim('  No findings.'));
    return;
  }
  // Group by category for readability.
  const byCategory = new Map<string, TestFinding[]>();
  for (const f of findings) {
    const key = f.category || '(uncategorized)';
    const list = byCategory.get(key) ?? [];
    list.push(f);
    byCategory.set(key, list);
  }
  for (const [category, list] of Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(pc.bold(`▸ ${category} (${list.length})`));
    for (const f of list) {
      const sev = colorForSeverity(f.severity)(`[${f.severity}]`);
      const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : (f.behaviorId ? `behavior ${f.behaviorId}` : '-');
      console.log(`  ${sev} ${pc.cyan(loc)}`);
      console.log(`    ${f.description}`);
      if (f.suggestedFix?.rationale) console.log(`    ${pc.dim('fix:')} ${f.suggestedFix.rationale}`);
      if (f.confidence) console.log(`    ${pc.dim('confidence:')} ${f.confidence}`);
    }
    console.log('');
  }
}

// ── Subcommand: anvil test generate <plan-slug> ──────────────────────────

const generateCmd = new Command('generate')
  .description('Generate a TestSpec from an existing Plan (requires `anvil dashboard` running)')
  .argument('<plan-slug>', 'Plan slug to generate tests from')
  .option('--project <name>', 'Project name (defaults to factory.yaml in cwd)')
  .option('--model <id>', 'Model id to use for test generation')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (planSlug: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Connected to dashboard at ${client.url}`);
      info(`Generating TestSpec from plan ${pc.bold(planSlug)} for project ${pc.bold(project)}...`);
      process.stderr.write('\n');

      const result = await client.request<{ spec: TestSpec }>(
        { action: 'create-test-spec-from-plan', project, planSlug, model: opts.model },
        {
          resolveOn: ['test-spec-created'],
          rejectOn: ['error', 'test-spec-error'],
          onMessage: streamAgentOutput,
          timeoutMs: 10 * 60_000,
        },
      );

      const spec = result.payload.spec;
      process.stderr.write('\n');
      success(`TestSpec created: ${pc.bold(spec.title)}`);
      console.error(`  slug:       ${spec.slug}`);
      console.error(`  behaviors:  ${spec.behaviors.length}`);
      if (spec.findings?.length) console.error(`  findings:   ${spec.findings.length}`);
      console.error('');
      info(`View:  ${pc.cyan(`anvil test show ${spec.slug} --project ${project}`)}`);
      info(`Run:   ${pc.cyan(`anvil test run ${spec.slug} --project ${project}`)}`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil test list ──────────────────────────────────────────

const listCmd = new Command('list')
  .description('List TestSpecs for a project')
  .option('--project <name>', 'Project name (omit to list all)')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = opts.project ?? (() => {
      try { return resolveProject(undefined); } catch { return undefined; }
    })();
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ specs: TestSpecPointer[] }>(
        { action: 'get-test-specs', project },
        { resolveOn: ['test-specs'], rejectOn: ['error'] },
      );

      const specs = payload.specs ?? [];
      if (specs.length === 0) {
        info(project ? `No test specs for project "${project}".` : 'No test specs found.');
        return;
      }

      fmtTable(
        ['SLUG', 'TITLE', 'BEHAVIORS', 'PLAN', 'UPDATED'],
        specs.map((s) => [
          s.slug,
          truncate(s.title, 40),
          String(s.behaviorCount),
          s.planSlug ?? '-',
          (s.updatedAt || '').slice(0, 16).replace('T', ' '),
        ]),
      );
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil test show <slug> ───────────────────────────────────

const showCmd = new Command('show')
  .description('Show a TestSpec with its behaviors and emitted test cases')
  .argument('<slug>', 'TestSpec slug')
  .option('--project <name>', 'Project name')
  .option('--json', 'Print the full spec JSON to stdout', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (slug: string, opts: Record<string, string | boolean | undefined>) => {
    const project = resolveProject(opts.project as string | undefined);
    const port = parseInt((opts.port as string) || '5173', 10);
    const asJson = !!opts.json;

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });

      const specResp = await client.request<{ spec: TestSpec | null }>(
        { action: 'get-test-spec', project, slug },
        { resolveOn: ['test-spec'], rejectOn: ['error'] },
      );
      const spec = specResp.payload.spec;
      if (!spec) {
        error(`TestSpec not found: ${project}/${slug}`);
        process.exitCode = 1;
        return;
      }

      const casesResp = await client.request<{ cases: TestCase[] }>(
        { action: 'get-test-cases', project, slug },
        { resolveOn: ['test-cases'], rejectOn: ['error'] },
      );
      const cases = casesResp.payload.cases ?? [];

      if (asJson) {
        process.stdout.write(JSON.stringify({ spec, cases }, null, 2) + '\n');
        return;
      }

      console.log(pc.bold(`TestSpec ${spec.slug}`));
      console.log(`  Title:      ${spec.title}`);
      if (spec.planSlug) console.log(`  Plan:       ${spec.planSlug}`);
      console.log(`  Behaviors:  ${spec.behaviors.length}`);
      console.log(`  Cases:      ${cases.length}`);
      if (spec.model) console.log(`  Model:      ${spec.model}`);
      console.log(`  Updated:    ${(spec.updatedAt || '').slice(0, 16).replace('T', ' ')}`);
      console.log('');

      console.log(pc.bold('Behaviors'));
      if (spec.behaviors.length === 0) {
        console.log(pc.dim('  (none)'));
      } else {
        fmtTable(
          ['ID', 'LEVEL', 'DESCRIPTION'],
          spec.behaviors.map((b) => [
            b.id,
            colorForLevel(b.level)(b.level),
            truncate(b.description, 70),
          ]),
        );
      }
      console.log('');

      if (cases.length) {
        console.log(pc.bold('Test Cases'));
        fmtTable(
          ['CASE ID', 'BEHAVIOR', 'FILE'],
          cases.map((c) => [c.caseId, c.behaviorId, c.file]),
        );
        console.log('');
      }

      const findings = spec.findings ?? [];
      console.log(pc.bold(`Findings (${findings.length})`));
      printFindings(findings);

      const blockers = findings.filter((f) => f.severity === 'blocker' || f.severity === 'error').length;
      if (blockers > 0) process.exitCode = 1;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil test run <slug> ────────────────────────────────────

const runCmd = new Command('run')
  .description('Trigger a TestRun for a TestSpec')
  .argument('<slug>', 'TestSpec slug')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (slug: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Connected to dashboard at ${client.url}`);
      info(`Running TestSpec ${pc.bold(slug)} for project ${pc.bold(project)}...`);
      process.stderr.write('\n');

      const result = await client.request<{ run: TestRunPointer }>(
        { action: 'run-test-spec', project, slug },
        {
          resolveOn: ['test-run-started', 'test-run-completed'],
          rejectOn: ['error', 'test-run-error'],
          onMessage: streamAgentOutput,
          timeoutMs: 15 * 60_000,
        },
      );

      const run = result.payload.run;
      process.stderr.write('\n');
      const statusColor = colorForStatus(run.status);
      console.log(`${pc.bold('Run:')}    ${run.runId}`);
      console.log(`${pc.bold('Status:')} ${statusColor(run.status.toUpperCase())}`);
      if (run.startedAt) console.log(`${pc.bold('Started:')} ${run.startedAt.slice(0, 16).replace('T', ' ')}`);
      console.log('');
      info(`Watch: ${pc.cyan(`http://localhost:${port}/#/tests`)}`);

      if (run.status === 'failed' || run.status === 'error') process.exitCode = 1;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil test fingerprint ───────────────────────────────────

const fingerprintCmd = new Command('fingerprint')
  .description('Run the convention fingerprinter only. Prints the ConventionFingerprint JSON.')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Fingerprinting test conventions for ${pc.bold(project)}...`);
      process.stderr.write('\n');

      const result = await client.request<{ fingerprint: ConventionFingerprint }>(
        { action: 'fingerprint-test-conventions', project },
        {
          resolveOn: ['test-fingerprint'],
          rejectOn: ['error', 'test-fingerprint-error'],
          onMessage: streamAgentOutput,
          timeoutMs: 5 * 60_000,
        },
      );

      process.stderr.write('\n');
      process.stdout.write(JSON.stringify(result.payload.fingerprint, null, 2) + '\n');
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Command group ───────────────────────────────────────────────────────

export const testCommand = new Command('test')
  .description('Generate, inspect, and run AI-authored tests')
  .addCommand(generateCmd)
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(runCmd)
  .addCommand(fingerprintCmd);
