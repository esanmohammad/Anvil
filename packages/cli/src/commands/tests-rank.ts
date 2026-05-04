/**
 * `anvil tests rank <pr-url>` — emit the AST-graph-reachable test list for a
 * PR, ranked by graph distance.
 *
 * The dashboard server owns the ranking (it holds the per-repo AST graphs
 * via `KnowledgeBaseManager`). This CLI is a thin client: POST the pr-url
 * to `/api/tests/rank`, render the response. We deliberately use the HTTP
 * endpoint rather than the WS action so CI scripts can call this command
 * without keeping a WS connection open — `--format list` is specifically
 * designed to be piped into `xargs` or `jest` in a bash pipeline.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';

import { getAnvilHome } from '../home.js';
import { error, info } from '../logger.js';

// ── Local type mirrors (mirrors RelevanceResult from the dashboard package) ─

interface RankedTest {
  testFile: string;
  testName?: string;
  distance: number;
  matchedSymbols: string[];
  repoName: string;
}

interface RelevanceResult {
  totalTests: number;
  rankedRelevant: RankedTest[];
  estimatedRuntimeMs: number;
  estimatedSavings: string;
}

// ── Project resolution (same shape as cost.ts / incidents.ts) ─────────────

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
    error('Multiple projects configured — please pass --project <slug>.');
  }
  process.exit(1);
}

// ── HTTP ──────────────────────────────────────────────────────────────────

async function postRank(
  host: string,
  port: number,
  body: { project: string; prUrl: string },
): Promise<RelevanceResult> {
  const url = `http://${host}:${port}/api/tests/rank`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the dashboard at ${url}. Is it running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dashboard returned ${res.status}: ${text || res.statusText}`);
  }
  const parsed = await res.json().catch(() => null) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Malformed response from the dashboard (expected JSON object).');
  }
  return parsed as RelevanceResult;
}

// ── Output formatters ─────────────────────────────────────────────────────

function renderList(result: RelevanceResult): void {
  // One filename per line — suitable for xargs / jest passthrough.
  for (const t of result.rankedRelevant) {
    process.stdout.write(t.testFile + '\n');
  }
}

function renderJson(result: RelevanceResult): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function renderTable(result: RelevanceResult): void {
  const { rankedRelevant, totalTests, estimatedSavings } = result;
  if (rankedRelevant.length === 0) {
    info('No tests are reachable from this PR on the AST graph.');
    return;
  }
  console.log(pc.bold(`Relevant tests  (${rankedRelevant.length} of ${totalTests})`));
  console.log(pc.dim(estimatedSavings));
  console.log('');
  const widths = [4, 0, 0];
  for (const r of rankedRelevant) {
    widths[1] = Math.max(widths[1], r.testFile.length);
    widths[2] = Math.max(widths[2], r.matchedSymbols.length.toString().length);
  }
  widths[1] = Math.min(widths[1], 80);
  const header = `${'DIST'.padEnd(widths[0])}  ${'TEST FILE'.padEnd(widths[1])}  SYMBOLS`;
  console.log(pc.bold(header));
  console.log(pc.dim('─'.repeat(header.length)));
  for (const r of rankedRelevant) {
    const dist = `d${r.distance}`.padEnd(widths[0]);
    const file = r.testFile.length > widths[1]
      ? '…' + r.testFile.slice(-(widths[1] - 1))
      : r.testFile.padEnd(widths[1]);
    const syms = r.matchedSymbols.slice(0, 3).join(', ')
      + (r.matchedSymbols.length > 3 ? ` (+${r.matchedSymbols.length - 3})` : '');
    console.log(`${dist}  ${file}  ${pc.dim(syms)}`);
  }
}

// ── Command ───────────────────────────────────────────────────────────────

const rankCmd = new Command('rank')
  .description('Rank tests by AST-graph reachability for a PR diff')
  .argument('<pr-url>', 'GitHub PR URL')
  .option('--project <slug>', 'Project slug (defaults to the one in factory.yaml)')
  .option('--format <mode>', 'Output: json | list | table', 'table')
  .option('--port <port>', 'Dashboard port', '5173')
  .option('--host <host>', 'Dashboard host', 'localhost')
  .action(async (prUrl: string, opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const port = parseInt(opts.port || '5173', 10);
    const host = opts.host || 'localhost';
    const format = (opts.format || 'table').toLowerCase();
    if (format !== 'json' && format !== 'list' && format !== 'table') {
      error(`Unknown --format: ${opts.format}. Expected one of: json, list, table.`);
      process.exitCode = 1;
      return;
    }

    try {
      const result = await postRank(host, port, { project, prUrl });
      if (format === 'json') renderJson(result);
      else if (format === 'list') renderList(result);
      else renderTable(result);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

export const testsRankCommand = new Command('tests')
  .description('CI triage — rank, list, and inspect tests for a PR')
  .addCommand(rankCmd);
