/**
 * `anvil incidents` — command group for the Bug-to-Test Replay feature.
 *
 * All subcommands talk to a running `anvil dashboard` over WebSocket. They
 * resolve the active project from --project, ./factory.yaml, or ./anvil.yaml,
 * and exit with actionable error messages when the dashboard isn't running.
 *
 * Mirrors the pattern established by `plan.ts`, `review.ts`, and `test.ts`.
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import pc from 'picocolors';
import { info, success, error } from '../logger.js';
import { getAnvilHome } from '../home.js';
import { connectDashboard, type DashboardClient, type DashboardMessage } from '../lib/dashboard-ws.js';

// ── Types (narrow local mirrors of the dashboard-side types) ─────────────

type IncidentSeverity = 'blocker' | 'error' | 'warn' | 'info';
type IncidentSource = 'sentry' | 'incidentio' | 'jira' | 'linear' | 'github' | 'manual';

interface FailingSymbol { file: string; function: string; line: number }

interface IncidentRecord {
  incidentId: string;
  externalId: string;
  source: IncidentSource;
  url?: string | null;
  title: string;
  severity: IncidentSeverity;
  occurredAt: string;
  summary: string;
  stackTrace?: string | null;
  failingSymbol?: FailingSymbol | null;
  requestPayload?: string | null;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

interface IncidentPointer {
  incidentId: string;
  externalId: string;
  source: IncidentSource;
  title: string;
  severity: IncidentSeverity;
  occurredAt: string;
}

interface IncidentStats {
  total: number;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
}

interface ReplayResult {
  incidentId: string;
  testFile: string;
  runner?: string;
  status: 'reproduced' | 'not-reproduced' | 'error';
  summary?: string;
}

// ── Project resolution (mirrors plan.ts/review.ts/test.ts) ───────────────

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

// ── URL source detection ─────────────────────────────────────────────────

interface UrlDetection { source: IncidentSource; externalId: string | null }

/**
 * Detect the incident source from a URL. Matches Sentry, incident.io,
 * Jira, Linear, and GitHub issue URL shapes.
 */
function detectSourceFromUrl(url: string): UrlDetection {
  const u = (url || '').trim();
  // Sentry: https://<org>.sentry.io/issues/<id>/ or /share/issue/<hash>/
  let m = u.match(/^https?:\/\/[^/]*sentry\.io\/(?:organizations\/[^/]+\/)?(?:issues|share\/issue)\/([^/?#]+)/i);
  if (m) return { source: 'sentry', externalId: m[1] };
  // incident.io: https://app.incident.io/<org>/incidents/<id>
  m = u.match(/^https?:\/\/(?:app\.)?incident\.io\/[^/]+\/incidents\/([^/?#]+)/i);
  if (m) return { source: 'incidentio', externalId: m[1] };
  // Jira: https://<tenant>.atlassian.net/browse/<KEY-123>
  m = u.match(/^https?:\/\/[^/]*atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
  if (m) return { source: 'jira', externalId: m[1] };
  // Linear: https://linear.app/<team>/issue/<KEY-123>
  m = u.match(/^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+-\d+)/i);
  if (m) return { source: 'linear', externalId: m[1] };
  // GitHub issue: https://github.com/owner/repo/issues/123
  m = u.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/i);
  if (m) return { source: 'github', externalId: m[1] };
  return { source: 'manual', externalId: null };
}

// ── Interactive prompt helpers ───────────────────────────────────────────

function createRL(): ReturnType<typeof createInterface> {
  return createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${pc.cyan('?')} ${question}: `, (answer) => resolve(answer.trim()));
  });
}

async function askMultiline(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  process.stderr.write(`${pc.cyan('?')} ${question}\n`);
  process.stderr.write(`${pc.dim('  (paste input, then an empty line to finish)')}\n`);
  const lines: string[] = [];
  return new Promise((resolve) => {
    const onLine = (line: string) => {
      if (line === '') {
        rl.off('line', onLine);
        resolve(lines.join('\n'));
        return;
      }
      lines.push(line);
    };
    rl.on('line', onLine);
  });
}

// ── Agent-output + replay-step streaming (to stderr) ─────────────────────

function streamAgentOutput(msg: DashboardMessage): void {
  if (msg.type === 'agent-output') {
    const payload = msg.payload as { entries?: Array<{ content?: string; summary?: string; kind?: string }> } | undefined;
    const entries = payload?.entries;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const text = (entry.content || entry.summary || '').trim();
      if (!text) continue;
      const lines = text.split(/\r?\n/).slice(0, 4);
      for (const line of lines) process.stderr.write(`  ${pc.dim('│')} ${line}\n`);
    }
    return;
  }
  if (msg.type === 'replay-step') {
    const payload = msg.payload as { step?: string; detail?: string } | undefined;
    const step = (payload?.step || '').trim();
    const detail = (payload?.detail || '').trim();
    if (!step && !detail) return;
    const label = step ? pc.bold(step) : pc.dim('step');
    process.stderr.write(`  ${pc.cyan('▸')} ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

// ── Rendering helpers ────────────────────────────────────────────────────

function colorForSeverity(severity: IncidentSeverity): (s: string) => string {
  switch (severity) {
    case 'blocker':
    case 'error': return pc.red;
    case 'warn': return pc.yellow;
    case 'info': return pc.blue;
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

function renderHistogram(title: string, counts: Record<string, number>): void {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log(pc.dim(`  (no ${title.toLowerCase()})`));
    return;
  }
  const max = Math.max(...entries.map(([, n]) => n));
  const maxLabel = Math.max(...entries.map(([k]) => k.length));
  const barWidth = 30;
  console.log(pc.bold(title));
  for (const [key, n] of entries) {
    const bar = '█'.repeat(Math.max(1, Math.round((n / max) * barWidth)));
    console.log(`  ${key.padEnd(maxLabel)}  ${pc.cyan(bar)} ${n}`);
  }
}

// ── Subcommand: anvil incidents list ─────────────────────────────────────

const listCmd = new Command('list')
  .description('List recent incidents for a project')
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
      const { payload } = await client.request<{ incidents: IncidentPointer[] }>(
        { action: 'list-incidents', project },
        { resolveOn: ['incidents'], rejectOn: ['error'] },
      );

      const incidents = payload.incidents ?? [];
      if (incidents.length === 0) {
        info(project ? `No incidents for project "${project}".` : 'No incidents found.');
        return;
      }

      fmtTable(
        ['INCIDENT ID', 'EXTERNAL', 'SOURCE', 'SEVERITY', 'OCCURRED', 'TITLE'],
        incidents.map((i) => [
          i.incidentId,
          i.externalId,
          i.source,
          colorForSeverity(i.severity)(i.severity),
          (i.occurredAt || '').slice(0, 16).replace('T', ' '),
          truncate(i.title, 50),
        ]),
      );
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil incidents show <incident-id> ───────────────────────

const showCmd = new Command('show')
  .description('Show a single incident with its stack trace and payload')
  .argument('<incidentId>', 'Incident id')
  .option('--project <name>', 'Project name')
  .option('--json', 'Print the raw incident JSON', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (incidentId: string, opts: Record<string, string | boolean | undefined>) => {
    const project = resolveProject(opts.project as string | undefined);
    const port = parseInt((opts.port as string) || '5173', 10);
    const asJson = !!opts.json;

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ incident: IncidentRecord | null }>(
        { action: 'get-incident', project, incidentId },
        { resolveOn: ['incident'], rejectOn: ['error'] },
      );

      const incident = payload.incident;
      if (!incident) {
        error(`Incident not found: ${project}/${incidentId}`);
        process.exitCode = 1;
        return;
      }

      if (asJson) {
        process.stdout.write(JSON.stringify(incident, null, 2) + '\n');
        return;
      }

      const sevColor = colorForSeverity(incident.severity);
      console.log(pc.bold(`Incident ${incident.incidentId}`));
      console.log(`  External: ${incident.externalId} (${incident.source})`);
      console.log(`  Title:    ${incident.title}`);
      console.log(`  Severity: ${sevColor(incident.severity.toUpperCase())}`);
      console.log(`  Occurred: ${(incident.occurredAt || '').slice(0, 16).replace('T', ' ')}`);
      if (incident.url) console.log(`  URL:      ${pc.cyan(incident.url)}`);
      if (incident.tags?.length) console.log(`  Tags:     ${incident.tags.join(', ')}`);
      console.log('');

      if (incident.summary) {
        console.log(pc.bold('Summary'));
        console.log(`  ${incident.summary}`);
        console.log('');
      }

      if (incident.failingSymbol) {
        console.log(pc.bold('Failing Symbol'));
        console.log(`  ${pc.cyan(`${incident.failingSymbol.file}:${incident.failingSymbol.line}`)}`);
        console.log(`  function: ${incident.failingSymbol.function}`);
        console.log('');
      }

      if (incident.stackTrace) {
        console.log(pc.bold('Stack Trace'));
        for (const line of incident.stackTrace.split(/\r?\n/)) {
          console.log(`  ${pc.dim(line)}`);
        }
        console.log('');
      }

      if (incident.requestPayload) {
        console.log(pc.bold('Request Payload'));
        console.log(`  ${incident.requestPayload}`);
        console.log('');
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil incidents stats ────────────────────────────────────

const statsCmd = new Command('stats')
  .description('Show incident histograms by severity and source')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ stats: IncidentStats }>(
        { action: 'get-incident-stats', project },
        { resolveOn: ['incident-stats'], rejectOn: ['error'] },
      );

      const stats = payload.stats ?? { total: 0, bySeverity: {}, bySource: {} };
      console.log(pc.bold(`Incident stats for ${project}`));
      console.log(`  Total: ${stats.total}`);
      console.log('');
      renderHistogram('By severity', stats.bySeverity ?? {});
      console.log('');
      renderHistogram('By source', stats.bySource ?? {});
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil incidents replay <incident-url|--flags> ────────────

interface ReplayOpts {
  project?: string;
  model?: string;
  port?: string;
  sentryIssue?: string;
  incidentioId?: string;
  stack?: string;
  manual?: boolean;
}

/**
 * Build the `ingest-incident` payload from the replay command's flags. The
 * command supports five entry points: a URL argument (auto-detected), explicit
 * --sentry-issue / --incidentio-id ids, a --stack file, or --manual which
 * prompts on stderr for a stack trace + title.
 */
async function buildIngestPayload(
  incidentUrl: string | undefined,
  opts: ReplayOpts,
): Promise<{ source: IncidentSource; payload: Record<string, unknown> }> {
  if (incidentUrl) {
    const detected = detectSourceFromUrl(incidentUrl);
    return {
      source: detected.source,
      payload: { url: incidentUrl, externalId: detected.externalId, source: detected.source },
    };
  }

  if (opts.sentryIssue) {
    return { source: 'sentry', payload: { externalId: opts.sentryIssue, source: 'sentry' } };
  }

  if (opts.incidentioId) {
    return { source: 'incidentio', payload: { externalId: opts.incidentioId, source: 'incidentio' } };
  }

  if (opts.stack) {
    const stackPath = opts.stack;
    if (!existsSync(stackPath)) {
      error(`Stack trace file not found: ${stackPath}`);
      process.exit(1);
    }
    const stackTrace = readFileSync(stackPath, 'utf-8');
    return {
      source: 'manual',
      payload: {
        source: 'manual',
        stackTrace,
        title: `Replay from ${stackPath}`,
        externalId: `stack-${Date.now()}`,
      },
    };
  }

  if (opts.manual) {
    const rl = createRL();
    try {
      const title = await ask(rl, 'Incident title');
      if (!title) {
        error('Title is required for --manual.');
        process.exit(1);
      }
      const stackTrace = await askMultiline(rl, 'Paste stack trace');
      if (!stackTrace.trim()) {
        error('Stack trace is required for --manual.');
        process.exit(1);
      }
      return {
        source: 'manual',
        payload: {
          source: 'manual',
          title,
          stackTrace,
          externalId: `manual-${Date.now()}`,
        },
      };
    } finally {
      rl.close();
    }
  }

  error('Provide an incident URL or one of: --sentry-issue, --incidentio-id, --stack, --manual.');
  process.exit(1);
}

const replayCmd = new Command('replay')
  .description('Ingest an incident and generate a regression test that reproduces it')
  .argument('[incident-url]', 'Sentry / incident.io / Jira / Linear / GitHub issue URL')
  .option('--project <name>', 'Project name (defaults to factory.yaml in cwd)')
  .option('--model <id>', 'Model id to use for the replay')
  .option('--sentry-issue <id>', 'Sentry issue id (use instead of a URL)')
  .option('--incidentio-id <id>', 'incident.io incident id (use instead of a URL)')
  .option('--stack <path>', 'Path to a stack-trace file to ingest')
  .option('--manual', 'Prompt interactively for title + stack trace', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (incidentUrl: string | undefined, opts: ReplayOpts) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    const { source, payload } = await buildIngestPayload(incidentUrl, opts);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      info(`Connected to dashboard at ${client.url}`);
      info(`Ingesting incident from ${pc.bold(source)} for project ${pc.bold(project)}...`);
      process.stderr.write('\n');

      const ingestResult = await client.request<{ incident: IncidentRecord }>(
        { action: 'ingest-incident', project, source, payload, options: { model: opts.model } },
        {
          resolveOn: ['incident-ingested'],
          rejectOn: ['error', 'incident-error'],
          onMessage: streamAgentOutput,
          timeoutMs: 5 * 60_000,
        },
      );

      const incident = ingestResult.payload.incident;
      process.stderr.write('\n');
      success(`Incident ingested: ${pc.bold(incident.title)}`);
      console.error(`  incidentId: ${incident.incidentId}`);
      console.error(`  external:   ${incident.externalId} (${incident.source})`);
      if (incident.failingSymbol) {
        console.error(`  symbol:     ${incident.failingSymbol.file}:${incident.failingSymbol.line} (${incident.failingSymbol.function})`);
      }
      console.error('');
      info(`Replaying incident ${pc.bold(incident.incidentId)}...`);
      process.stderr.write('\n');

      const replayResult = await client.request<{ result: ReplayResult }>(
        { action: 'replay-incident', project, incidentId: incident.incidentId, options: { model: opts.model } },
        {
          resolveOn: ['replay-complete'],
          rejectOn: ['error', 'replay-error'],
          onMessage: streamAgentOutput,
          timeoutMs: 15 * 60_000,
        },
      );

      const result = replayResult.payload.result;
      process.stderr.write('\n');
      const statusColor = result.status === 'reproduced' ? pc.green
        : result.status === 'not-reproduced' ? pc.yellow
          : pc.red;
      console.log(`${pc.bold('Status:')}   ${statusColor(result.status.toUpperCase())}`);
      console.log(`${pc.bold('Test:')}     ${result.testFile}`);
      if (result.runner) console.log(`${pc.bold('Runner:')}   ${result.runner}`);
      if (result.summary) console.log(`${pc.bold('Summary:')}  ${result.summary}`);
      console.log('');
      info(`View: ${pc.cyan(`anvil incidents show ${incident.incidentId} --project ${project}`)}`);

      if (result.status === 'error') process.exitCode = 1;
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Command group ───────────────────────────────────────────────────────

export const incidentsCommand = new Command('incidents')
  .description('Ingest incidents and replay bugs as regression tests')
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(statsCmd)
  .addCommand(replayCmd);
