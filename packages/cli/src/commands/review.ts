/**
 * `anvil review` — command group for the PR Review feature.
 *
 * All subcommands talk to a running `anvil dashboard` over WebSocket. They
 * resolve the active project from --project, ./factory.yaml, or ./anvil.yaml,
 * and exit with actionable error messages when the dashboard isn't running.
 *
 * Mirrors the pattern established by `plan.ts`.
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { info, success, warn, error } from '../logger.js';
import { getAnvilHome } from '../home.js';
import { connectDashboard, type DashboardClient, type DashboardMessage } from '../lib/dashboard-ws.js';

// ── Types (narrow local mirrors of the dashboard-side types) ─────────────

type ReviewVerdict = 'approve' | 'request-changes' | 'comment';
type ReviewSeverity = 'blocker' | 'error' | 'warn' | 'info' | 'nit';

interface ReviewFinding {
  findingId: string;
  severity: ReviewSeverity;
  category: string;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
  resolution?: 'addressed' | 'dismissed' | 'wont-fix' | null;
}

interface ReviewEstimate { usd: number; tokens?: number }

interface Review {
  reviewId: string;
  project: string;
  prUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  verdict: ReviewVerdict;
  summary?: string;
  findings: ReviewFinding[];
  estimate: ReviewEstimate;
  model: string;
  createdAt: string;
  updatedAt?: string;
  severityCounts?: Record<string, number>;
}

interface ReviewPointer {
  reviewId: string;
  prUrl: string;
  verdict: ReviewVerdict;
  createdAt: string;
  severityCounts: Record<string, number>;
}

// ── Project resolution (mirrors plan.ts) ─────────────────────────────────

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

// ── GitHub PR URL parsing ────────────────────────────────────────────────

interface PrRef { owner: string; repo: string; number: number }

/**
 * Parse `https://github.com/owner/repo/pull/123` (or similar). Accepts
 * http/https, optional trailing slash or query, and exits with a clear
 * message when the URL doesn't match.
 */
function parsePrUrl(raw: string): PrRef {
  const trimmed = (raw || '').trim();
  const m = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!m) {
    error(`Invalid GitHub PR URL: ${trimmed || '(empty)'}`);
    error('Expected format: https://github.com/<owner>/<repo>/pull/<number>');
    process.exit(1);
  }
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
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

function colorForVerdict(verdict: ReviewVerdict): (s: string) => string {
  switch (verdict) {
    case 'approve': return pc.green;
    case 'request-changes': return pc.red;
    case 'comment': return pc.yellow;
    default: return (s) => s;
  }
}

function colorForSeverity(severity: ReviewSeverity): (s: string) => string {
  switch (severity) {
    case 'blocker':
    case 'error': return pc.red;
    case 'warn': return pc.yellow;
    case 'info': return pc.blue;
    case 'nit': return pc.dim;
    default: return (s) => s;
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function formatFileLine(f: ReviewFinding): string {
  if (!f.file) return '-';
  return f.line ? `${f.file}:${f.line}` : f.file;
}

function countBlockersErrors(findings: ReviewFinding[]): { blockers: number; errors: number; warns: number } {
  let blockers = 0, errors = 0, warns = 0;
  for (const f of findings) {
    if (f.severity === 'blocker') blockers++;
    else if (f.severity === 'error') errors++;
    else if (f.severity === 'warn') warns++;
  }
  return { blockers, errors, warns };
}

function countsFromMap(m: Record<string, number> | undefined): { blockers: number; errors: number; warns: number } {
  return {
    blockers: m?.blocker ?? 0,
    errors: m?.error ?? 0,
    warns: m?.warn ?? 0,
  };
}

/** Print a findings table to stdout (severity | category | file:line | description). */
function printFindingsTable(findings: ReviewFinding[]): void {
  if (findings.length === 0) {
    console.log(pc.dim('  No findings.'));
    return;
  }

  const header = ['SEVERITY', 'CATEGORY', 'LOCATION', 'DESCRIPTION'];
  const rows = findings.map((f) => [
    f.severity,
    f.category || '-',
    formatFileLine(f),
    truncate(f.description, 80),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  console.log(pc.bold(fmtRow(header)));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const color = colorForSeverity(findings[i].severity);
    // Color only the severity cell; leave the rest readable.
    const cells = row.map((c, idx) => c.padEnd(widths[idx]));
    cells[0] = color(cells[0]);
    console.log(cells.join('  '));
  }
}

// ── Shared runner for the top-level `anvil review <pr-url>` action ───────

interface RunReviewOpts {
  project?: string;
  model?: string;
  publish?: boolean;
  json?: boolean;
  port?: string;
}

async function runReview(prUrl: string, opts: RunReviewOpts): Promise<void> {
  const ref = parsePrUrl(prUrl);
  const project = resolveProject(opts.project);
  const port = parseInt(opts.port || '5173', 10);
  const publish = !!opts.publish;
  const asJson = !!opts.json;

  let client: DashboardClient | null = null;
  try {
    client = await connectDashboard({ port });
    info(`Connected to dashboard at ${client.url}`);
    info(`Reviewing ${pc.bold(`${ref.owner}/${ref.repo}#${ref.number}`)} for project ${pc.bold(project)}...`);
    process.stderr.write('\n');

    const result = await client.request<{ review: Review }>(
      { action: 'run-review-pr', project, prUrl, options: { model: opts.model } },
      {
        resolveOn: ['review-created'],
        rejectOn: ['error', 'review-error'],
        onMessage: streamAgentOutput,
        timeoutMs: 10 * 60_000,
      },
    );

    const review = result.payload.review;
    process.stderr.write('\n');

    if (asJson) {
      let publishInfo: { commentsPosted?: number; summaryUrl?: string } | null = null;
      if (publish) {
        const pub = await client.request<{ commentsPosted: number; summaryUrl: string }>(
          { action: 'publish-review', project, reviewId: review.reviewId },
          { resolveOn: ['review-published'], rejectOn: ['error'] },
        );
        publishInfo = pub.payload;
      }
      process.stdout.write(JSON.stringify({ review, publish: publishInfo }, null, 2) + '\n');
    } else {
      const verdictColor = colorForVerdict(review.verdict);
      console.log(`${pc.bold('Verdict:')} ${verdictColor(review.verdict.toUpperCase())}`);
      if (review.summary) console.log(`${pc.dim(review.summary)}`);
      console.log('');
      console.log(pc.bold('Findings'));
      printFindingsTable(review.findings);
      console.log('');
      console.log(`${pc.bold('Estimate:')} ~$${review.estimate.usd.toFixed(2)}`);

      if (publish) {
        process.stderr.write('\n');
        info('Publishing findings to GitHub...');
        const pub = await client.request<{ commentsPosted: number; summaryUrl: string }>(
          { action: 'publish-review', project, reviewId: review.reviewId },
          { resolveOn: ['review-published'], rejectOn: ['error'] },
        );
        success(`Published ${pub.payload.commentsPosted} comment(s).`);
        console.log('');
        console.log(`${pc.bold('Summary:')} ${pc.cyan(pub.payload.summaryUrl)}`);
      }
    }

    const { blockers, errors } = countBlockersErrors(review.findings);
    if (blockers > 0 || errors > 0) process.exitCode = 1;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}

// ── Subcommand: anvil review list ────────────────────────────────────────

const listCmd = new Command('list')
  .description('List recent reviews for a project')
  .option('--project <name>', 'Project name')
  .option('--limit <n>', 'Max number of reviews to show', '20')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = opts.project ?? (() => {
      try { return resolveProject(undefined); } catch { return undefined; }
    })();
    const port = parseInt(opts.port || '5173', 10);
    const limit = Math.max(1, parseInt(opts.limit || '20', 10) || 20);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ reviews: ReviewPointer[] }>(
        { action: 'list-reviews', project },
        { resolveOn: ['reviews'], rejectOn: ['error'] },
      );

      const reviews = (payload.reviews ?? []).slice(0, limit);
      if (reviews.length === 0) {
        info(project ? `No reviews for project "${project}".` : 'No reviews found.');
        return;
      }

      const header = ['REVIEW ID', 'VERDICT', 'CREATED', 'B/E/W', 'PR URL'];
      const rows = reviews.map((r) => {
        const { blockers, errors, warns } = countsFromMap(r.severityCounts);
        return [
          r.reviewId,
          r.verdict,
          (r.createdAt || '').slice(0, 16).replace('T', ' '),
          `${blockers}/${errors}/${warns}`,
          r.prUrl,
        ];
      });
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      const fmtRow = (cells: string[]): string =>
        cells.map((c, i) => c.padEnd(widths[i])).join('  ');

      console.log(pc.bold(fmtRow(header)));
      console.log(widths.map((w) => '─'.repeat(w)).join('  '));
      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].map((c, idx) => c.padEnd(widths[idx]));
        cells[1] = colorForVerdict(reviews[i].verdict)(cells[1]);
        console.log(cells.join('  '));
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil review show <review-id> ────────────────────────────

const showCmd = new Command('show')
  .description('Show a single review. Findings are grouped by category.')
  .argument('<review-id>', 'Review id')
  .option('--project <name>', 'Project name')
  .option('--json', 'Print the raw review JSON', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (reviewId: string, opts: Record<string, string | boolean | undefined>) => {
    const project = resolveProject(opts.project as string | undefined);
    const port = parseInt((opts.port as string) || '5173', 10);
    const asJson = !!opts.json;

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      const { payload } = await client.request<{ review: Review | null }>(
        { action: 'get-review', project, reviewId },
        { resolveOn: ['review'], rejectOn: ['error'] },
      );

      if (!payload.review) {
        error(`Review not found: ${project}/${reviewId}`);
        process.exitCode = 1;
        return;
      }

      const review = payload.review;

      if (asJson) {
        process.stdout.write(JSON.stringify(review, null, 2) + '\n');
        return;
      }

      const verdictColor = colorForVerdict(review.verdict);
      console.log(pc.bold(`Review ${review.reviewId}`));
      console.log(`  PR:      ${review.prUrl}`);
      console.log(`  Verdict: ${verdictColor(review.verdict.toUpperCase())}`);
      console.log(`  Created: ${(review.createdAt || '').slice(0, 16).replace('T', ' ')}`);
      console.log(`  Model:   ${review.model}`);
      if (review.summary) {
        console.log('');
        console.log(pc.dim(review.summary));
      }
      console.log('');

      // Group findings by category.
      const byCategory = new Map<string, ReviewFinding[]>();
      for (const f of review.findings) {
        const key = f.category || '(uncategorized)';
        const list = byCategory.get(key) ?? [];
        list.push(f);
        byCategory.set(key, list);
      }

      if (byCategory.size === 0) {
        console.log(pc.dim('No findings.'));
        return;
      }

      for (const [category, list] of Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(pc.bold(`▸ ${category} (${list.length})`));
        for (const f of list) {
          const sev = colorForSeverity(f.severity)(`[${f.severity}]`);
          const loc = formatFileLine(f);
          console.log(`  ${sev} ${pc.cyan(loc)}`);
          console.log(`    ${f.description}`);
          if (f.suggestion) console.log(`    ${pc.dim('suggestion:')} ${f.suggestion}`);
          if (f.resolution) console.log(`    ${pc.dim('resolution:')} ${f.resolution}`);
        }
        console.log('');
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Subcommand: anvil review resolve <review-id> <finding-id> <resolution>

const VALID_RESOLUTIONS = ['addressed', 'dismissed', 'wont-fix'] as const;

const resolveCmd = new Command('resolve')
  .description('Mark a review finding as addressed, dismissed, or wont-fix')
  .argument('<review-id>', 'Review id')
  .argument('<finding-id>', 'Finding id within the review')
  .argument('<resolution>', 'One of: addressed | dismissed | wont-fix')
  .option('--project <name>', 'Project name')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (reviewId: string, findingId: string, resolution: string, opts: Record<string, string | undefined>) => {
    if (!(VALID_RESOLUTIONS as readonly string[]).includes(resolution)) {
      error(`Invalid resolution: ${resolution}`);
      error(`Expected one of: ${VALID_RESOLUTIONS.join(', ')}`);
      process.exit(1);
    }
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);

    let client: DashboardClient | null = null;
    try {
      client = await connectDashboard({ port });
      await client.request(
        { action: 'resolve-review-finding', project, reviewId, findingId, resolution },
        { resolveOn: ['review-finding-resolved'], rejectOn: ['error'] },
      );
      success(`Resolved ${findingId} as ${resolution}.`);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      client?.close();
    }
  });

// ── Command group ───────────────────────────────────────────────────────

// ── Subcommand: anvil review run <pr-url> ────────────────────────────────

const runCmd = new Command('run')
  .description('Run a review on a GitHub pull request (requires `anvil dashboard` running)')
  .argument('<pr-url>', 'GitHub pull request URL')
  .option('--project <name>', 'Project name (defaults to factory.yaml in cwd)')
  .option('--model <id>', 'Model id to use for the review')
  .option('--publish', 'Publish findings as PR comments on completion', false)
  .option('--json', 'Print the full review JSON to stdout instead of the table', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (prUrl: string, opts: RunReviewOpts) => {
    await runReview(prUrl, opts);
  });

// ── Command group ───────────────────────────────────────────────────────

/**
 * `anvil review <pr-url>` runs a new review. Subcommands cover run/list/show/resolve.
 *
 * Commander routes first to any matching subcommand name; when the first
 * positional doesn't match one, the default action runs and the argument is
 * treated as a PR URL (a shortcut for `anvil review run <pr-url>`).
 */
export const reviewCommand = new Command('review')
  .description('Run AI code reviews on GitHub pull requests')
  .argument('[pr-url]', 'GitHub pull request URL (shortcut for `review run <pr-url>`)')
  .option('--project <name>', 'Project name (defaults to factory.yaml in cwd)')
  .option('--model <id>', 'Model id to use for the review')
  .option('--publish', 'Publish findings as PR comments on completion', false)
  .option('--json', 'Print the full review JSON to stdout instead of the table', false)
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async function (this: Command, prUrl: string | undefined) {
    if (!prUrl) {
      this.help();
      return;
    }
    const opts = this.opts<RunReviewOpts>();
    await runReview(prUrl, opts);
  })
  .addCommand(runCmd)
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(resolveCmd);
