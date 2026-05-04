/**
 * `anvil contracts` — command group for Contract Guard.
 *
 * Subcommands talk to a running `anvil dashboard` over HTTP (the dashboard
 * exposes `/api/contracts/*` — see `contract-ui-INTEGRATION.md`). If no
 * dashboard is running and `$ANVIL_DASHBOARD_URL` is unset, we fall back to
 * direct-local file reads from `~/.anvil/projects/<slug>/contracts.json`
 * so developers can still inspect cached discovery output offline.
 *
 * Mirrors the CLI pattern established by `incidents.ts` and `cost.ts`.
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';
import { getAnvilHome } from '../home.js';

// ── Types (narrow local mirrors of the dashboard-side types) ─────────────

type ContractKind = 'openapi' | 'protobuf' | 'graphql' | 'jsonschema' | 'avro';
type ChangeSeverity = 'breaking' | 'non-breaking' | 'needs-review';

interface ContractSummary {
  name: string;
  kind: ContractKind;
  repoName: string;
  sourceFile: string;
  version?: string;
  endpointCount: number;
}

interface ContractChange {
  kind: string;
  severity: ChangeSeverity;
  path: string;
  before?: string;
  after?: string;
  description: string;
}

interface ContractCall {
  repoName: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

interface ImpactReport {
  breakingChanges: ContractChange[];
  affectedCallsByChange: Array<{ change: ContractChange; calls: ContractCall[] }>;
  affectedConsumerRepos: string[];
  totalBreakingCallSites: number;
}

interface VerifyRunResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ testFile: string; message: string }>;
}

interface GenerateResult {
  writtenFiles: string[];
  skipped: string[];
}

// ── Project resolution (mirrors incidents.ts) ────────────────────────────

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
  } catch {
    return [];
  }
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
    for (const p of projects) error(`  - ${p}`);
  }
  process.exit(1);
}

// ── HTTP plumbing ──────────────────────────────────────────────────────

function dashboardBaseUrl(explicitPort?: string): string {
  const fromEnv = process.env.ANVIL_DASHBOARD_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const port = explicitPort ? parseInt(explicitPort, 10) : 5173;
  return `http://localhost:${port}`;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return (await res.json()) as T;
}

function isConnRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed/i.test(msg);
}

// ── Local fallback (offline mode) ──────────────────────────────────────

function localContractsCachePath(projectSlug: string): string {
  return join(getAnvilHome(), 'projects', projectSlug, 'contracts.json');
}

function loadLocalContracts(projectSlug: string): ContractSummary[] | null {
  const path = localContractsCachePath(projectSlug);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const data = raw as { contracts?: ContractSummary[] };
    return Array.isArray(data.contracts) ? data.contracts : null;
  } catch {
    return null;
  }
}

// ── Rendering helpers ──────────────────────────────────────────────────

function severityColor(severity: ChangeSeverity): (s: string) => string {
  switch (severity) {
    case 'breaking':
      return pc.red;
    case 'needs-review':
      return pc.yellow;
    case 'non-breaking':
      return pc.green;
    default:
      return (s) => s;
  }
}

function fmtTable(header: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  console.log(pc.bold(fmtRow(header)));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(fmtRow(row));
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// ── Subcommand: anvil contracts list ───────────────────────────────────

const listCmd = new Command('list')
  .description('List discovered contracts for a project')
  .option('--project <slug>', 'Project slug')
  .option('--repo <name>', 'Filter by repo name')
  .option('--port <port>', 'Dashboard port', '5173')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const project = resolveProject(opts.project as string | undefined);
    const repoFilter = opts.repo as string | undefined;
    const asJson = !!opts.json;
    const baseUrl = dashboardBaseUrl(opts.port as string | undefined);

    let contracts: ContractSummary[] | null = null;
    try {
      const payload = await getJson<{ contracts: ContractSummary[] }>(
        `${baseUrl}/api/contracts/list?project=${encodeURIComponent(project)}`,
      );
      contracts = payload.contracts;
    } catch (err) {
      if (isConnRefused(err) && !process.env.ANVIL_DASHBOARD_URL) {
        warn('Dashboard not reachable — falling back to cached contracts.');
        contracts = loadLocalContracts(project);
        if (!contracts) {
          error(
            `No cached contracts for ${project}. Start \`anvil dashboard\` or set ANVIL_DASHBOARD_URL.`,
          );
          process.exitCode = 1;
          return;
        }
      } else {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
    }

    const filtered = repoFilter
      ? contracts.filter((c) => c.repoName === repoFilter)
      : contracts;

    if (asJson) {
      process.stdout.write(JSON.stringify({ contracts: filtered }, null, 2) + '\n');
      return;
    }

    if (filtered.length === 0) {
      info(
        repoFilter
          ? `No contracts for ${project} in repo ${repoFilter}.`
          : `No contracts discovered for ${project}.`,
      );
      return;
    }

    fmtTable(
      ['REPO', 'KIND', 'NAME', 'VERSION', 'EP', 'SOURCE'],
      filtered.map((c) => [
        c.repoName,
        c.kind,
        truncate(c.name, 30),
        c.version ?? '',
        String(c.endpointCount),
        truncate(c.sourceFile, 48),
      ]),
    );
  });

// ── Subcommand: anvil contracts drift ──────────────────────────────────

const driftCmd = new Command('drift')
  .description('Detect contract drift between two git refs')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--from <ref>', 'Base git ref', 'HEAD~1')
  .option('--to <ref>', 'Target git ref', 'HEAD')
  .option('--port <port>', 'Dashboard port', '5173')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const project = resolveProject(opts.project as string | undefined);
    const fromRef = (opts.from as string) || 'HEAD~1';
    const toRef = (opts.to as string) || 'HEAD';
    const asJson = !!opts.json;
    const baseUrl = dashboardBaseUrl(opts.port as string | undefined);

    try {
      const report = await postJson<{ impact: ImpactReport }>(
        `${baseUrl}/api/contracts/drift`,
        { project, fromRef, toRef },
      );
      const impact = report.impact;

      if (asJson) {
        process.stdout.write(JSON.stringify({ impact }, null, 2) + '\n');
        return;
      }

      const breakingCount = impact.breakingChanges.length;
      console.log(
        pc.bold(`Contract drift for ${project} (${fromRef} → ${toRef})`),
      );
      console.log(
        `  ${pc.red(String(breakingCount))} breaking · ${pc.yellow(
          String(impact.affectedConsumerRepos.length),
        )} repos · ${pc.yellow(String(impact.totalBreakingCallSites))} call sites`,
      );
      console.log('');

      if (impact.affectedCallsByChange.length === 0) {
        info('No drift detected.');
        return;
      }

      for (const group of impact.affectedCallsByChange) {
        const c = group.change;
        const sev = severityColor(c.severity)(c.severity.toUpperCase());
        console.log(`${pc.bold(sev)}  ${pc.cyan(c.kind)}  ${c.path}`);
        console.log(`  ${c.description}`);
        if (c.before || c.after) {
          console.log(
            `  ${pc.dim('before:')} ${c.before ?? '—'}  ${pc.dim('→')}  ${pc.dim('after:')} ${
              c.after ?? '—'
            }`,
          );
        }
        if (group.calls.length > 0) {
          for (const call of group.calls.slice(0, 10)) {
            console.log(
              `    ${pc.dim(call.repoName)}  ${call.filePath}:${call.lineNumber}  ${pc.dim(
                truncate(call.snippet, 80),
              )}`,
            );
          }
          if (group.calls.length > 10) {
            console.log(pc.dim(`    …and ${group.calls.length - 10} more`));
          }
        }
        console.log('');
      }

      if (breakingCount > 0) process.exitCode = 2;
    } catch (err) {
      if (isConnRefused(err)) {
        error(
          `Dashboard not reachable at ${baseUrl}. Run \`anvil dashboard\` or set ANVIL_DASHBOARD_URL.`,
        );
      } else {
        error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  });

// ── Subcommand: anvil contracts generate ───────────────────────────────

const generateCmd = new Command('generate')
  .description('Write contract tests for affected consumers')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--endpoint <id>', 'Endpoint id (e.g. "GET /api/users")')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const endpoint = opts.endpoint;
    if (!endpoint) {
      error('--endpoint is required');
      process.exitCode = 1;
      return;
    }
    const baseUrl = dashboardBaseUrl(opts.port);

    try {
      info(
        `Generating contract tests for ${pc.bold(endpoint)} in ${pc.bold(project)}...`,
      );
      const { result } = await postJson<{ result: GenerateResult }>(
        `${baseUrl}/api/contracts/generate`,
        { project, endpointId: endpoint },
      );

      if (result.writtenFiles.length === 0) {
        warn('No tests written — nothing affected by this endpoint?');
      } else {
        success(`Wrote ${result.writtenFiles.length} test file(s):`);
        for (const f of result.writtenFiles) console.log(`  ${pc.green('+')} ${f}`);
      }
      if (result.skipped.length > 0) {
        console.log('');
        info(`Skipped ${result.skipped.length} (already present):`);
        for (const f of result.skipped) console.log(`  ${pc.dim('·')} ${f}`);
      }
    } catch (err) {
      if (isConnRefused(err)) {
        error(
          `Dashboard not reachable at ${baseUrl}. Run \`anvil dashboard\` or set ANVIL_DASHBOARD_URL.`,
        );
      } else {
        error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  });

// ── Subcommand: anvil contracts verify ─────────────────────────────────

const verifyCmd = new Command('verify')
  .description('Run the written contract tests for a project')
  .requiredOption('--project <slug>', 'Project slug')
  .option('--port <port>', 'Dashboard port', '5173')
  .action(async (opts: Record<string, string | undefined>) => {
    const project = resolveProject(opts.project);
    const baseUrl = dashboardBaseUrl(opts.port);

    try {
      info(`Verifying contract tests for ${pc.bold(project)}...`);
      const { result } = await postJson<{ result: VerifyRunResult }>(
        `${baseUrl}/api/contracts/verify`,
        { project },
      );

      const line = `${pc.bold('Total:')} ${result.total}   ${pc.green(
        `${result.passed} passed`,
      )}   ${pc.red(`${result.failed} failed`)}   ${pc.dim(
        `${result.skipped} skipped`,
      )}`;
      console.log(line);

      if (result.failures.length > 0) {
        console.log('');
        console.log(pc.bold('Failures'));
        for (const f of result.failures) {
          console.log(`  ${pc.red('✗')} ${f.testFile}`);
          console.log(`    ${pc.dim(truncate(f.message, 200))}`);
        }
      }

      if (result.failed > 0) process.exitCode = 1;
    } catch (err) {
      if (isConnRefused(err)) {
        error(
          `Dashboard not reachable at ${baseUrl}. Run \`anvil dashboard\` or set ANVIL_DASHBOARD_URL.`,
        );
      } else {
        error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  });

// ── Command group ──────────────────────────────────────────────────────

export const contractsCommand = new Command('contracts')
  .description('Discover API contracts, detect drift, and write contract tests')
  .addCommand(listCmd)
  .addCommand(driftCmd)
  .addCommand(generateCmd)
  .addCommand(verifyCmd);
