/**
 * `anvil triage <log-url-or-file>` — CI log triage (Phase 3).
 *
 * Reads a CI log (from a local file, stdin, or a `gh` run URL), runs it
 * through the pattern clusterer, and prints top failure clusters. Optionally
 * persists the report to `<anvilHome>/ci-triage/<project>/` so the dashboard
 * can surface history and learned fixes.
 *
 * This command runs offline — it does not talk to the dashboard WebSocket.
 * To keep the CLI free of runtime imports from the server package, the
 * relevant types and a trimmed pattern library are duplicated here (same
 * rationale as `checkpoints.ts`).
 */

import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pc from 'picocolors';

import { getAnvilHome } from '../home.js';
import { error, info, success, warn } from '../logger.js';

// ── Duplicated types / minimal pattern library ──────────────────────────

type CiFailureSeverity = 'critical' | 'high' | 'medium' | 'low';
type CiFailurePattern =
  | 'oom' | 'port-conflict' | 'db-lock' | 'network-timeout' | 'known-flake'
  | 'dependency-mismatch' | 'permission-denied' | 'missing-file'
  | 'compile-error' | 'assertion-failure' | 'unknown';

interface PatternRule {
  pattern: CiFailurePattern;
  severity: CiFailureSeverity;
  matcher: RegExp;
  suggestedFix: string;
}

const PATTERNS: PatternRule[] = [
  { pattern: 'oom', severity: 'critical', matcher: /JavaScript heap out of memory|ENOMEM|Killed.*signal 9|cannot allocate memory|OutOfMemoryError/i, suggestedFix: 'Increase heap (--max-old-space-size) or the runner size.' },
  { pattern: 'port-conflict', severity: 'high', matcher: /EADDRINUSE|port.*already in use|address already in use/i, suggestedFix: 'Use a random free port or kill lingering processes.' },
  { pattern: 'db-lock', severity: 'high', matcher: /deadlock detected|database is locked|Lock wait timeout exceeded|SQLITE_BUSY/i, suggestedFix: 'Reduce parallelism or use per-test DB isolation.' },
  { pattern: 'network-timeout', severity: 'medium', matcher: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|request timeout|fetch failed|socket hang up/i, suggestedFix: 'Mock external services or add retries with jitter.' },
  { pattern: 'known-flake', severity: 'low', matcher: /flaky test|retrying after failure|test retry \(attempt/i, suggestedFix: 'Quarantine the test and open a ticket.' },
  { pattern: 'dependency-mismatch', severity: 'high', matcher: /ERESOLVE|peer dep|Cannot find module|MODULE_NOT_FOUND|NODE_MODULE_VERSION/i, suggestedFix: 'Run `npm ci` and verify lockfile consistency.' },
  { pattern: 'permission-denied', severity: 'medium', matcher: /EACCES|permission denied|operation not permitted|403 Forbidden/i, suggestedFix: 'Check file perms or CI token scopes.' },
  { pattern: 'missing-file', severity: 'medium', matcher: /ENOENT|no such file or directory|404 not found/i, suggestedFix: 'Verify previous step uploaded the artifact.' },
  { pattern: 'compile-error', severity: 'critical', matcher: /TS\d{4}:|Syntax error|Unexpected token|Compilation failed|error TS\d{4}/i, suggestedFix: 'Reproduce locally — the build is red.' },
  { pattern: 'assertion-failure', severity: 'high', matcher: /AssertionError|assert.*failed|expected .* to (equal|be|contain)|FAIL .*\.(test|spec)/i, suggestedFix: 'Inspect the expected/actual diff in the test report.' },
];

const SEV_WEIGHT: Record<CiFailureSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

interface Cluster {
  pattern: CiFailurePattern;
  severity: CiFailureSeverity;
  count: number;
  firstLine: number;
  lastLine: number;
  examples: string[];
  suggestedFix: string;
  confidence: number;
}

interface Report {
  logSource: string;
  totalLines: number;
  errorLines: number;
  clusters: Cluster[];
  unknownExcerpt: string[];
  computedAt: string;
}

// ── Clusterer (duplicated, minimal) ─────────────────────────────────────

function cluster(logText: string, logSource: string, extra: PatternRule[]): Report {
  const lines = logText.split(/\r?\n/);
  const filter = /error|fail|panic|fatal|exception|assert/i;
  const rules = extra.length > 0 ? [...extra, ...PATTERNS] : PATTERNS;

  const acc = new Map<CiFailurePattern, Cluster>();
  const unknown: string[] = [];
  let errorLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !filter.test(line)) continue;
    errorLines++;

    let matched: PatternRule | null = null;
    for (const rule of rules) {
      if (rule.matcher.test(line)) { matched = rule; break; }
    }
    if (!matched) {
      if (unknown.length < 10) unknown.push(line.slice(0, 400));
      continue;
    }

    const ln = i + 1;
    const existing = acc.get(matched.pattern);
    if (!existing) {
      acc.set(matched.pattern, {
        pattern: matched.pattern,
        severity: matched.severity,
        count: 1,
        firstLine: ln,
        lastLine: ln,
        examples: [line.slice(0, 400)],
        suggestedFix: matched.suggestedFix,
        confidence: 0,
      });
    } else {
      existing.count++;
      existing.lastLine = ln;
      if (existing.examples.length < 3) existing.examples.push(line.slice(0, 400));
      if (SEV_WEIGHT[matched.severity] > SEV_WEIGHT[existing.severity]) {
        existing.severity = matched.severity;
        existing.suggestedFix = matched.suggestedFix;
      }
    }
  }

  const clusters: Cluster[] = Array.from(acc.values()).map((c) => {
    const base = Math.min(1, c.count / 3);
    const bonus = c.severity === 'critical' ? 0.2 : 0;
    c.confidence = Math.round(Math.min(1, base + bonus) * 1000) / 1000;
    return c;
  }).sort((a, b) => {
    const sd = SEV_WEIGHT[b.severity] - SEV_WEIGHT[a.severity];
    if (sd !== 0) return sd;
    return b.count - a.count;
  });

  return {
    logSource,
    totalLines: lines.length,
    errorLines,
    clusters,
    unknownExcerpt: unknown,
    computedAt: new Date().toISOString(),
  };
}

// ── Log loading ─────────────────────────────────────────────────────────

function loadExtraPatterns(project: string | undefined): PatternRule[] {
  if (!project) return [];
  const file = join(getAnvilHome(), 'projects', project, 'ci-patterns.json');
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ pattern: CiFailurePattern; severity: CiFailureSeverity; matcher: string; suggestedFix: string }>;
    return raw.filter((r) => r && r.pattern && r.matcher).map((r) => ({
      pattern: r.pattern,
      severity: r.severity,
      matcher: new RegExp(r.matcher, 'i'),
      suggestedFix: r.suggestedFix || '',
    }));
  } catch (e) {
    warn(`Failed to parse ${file}: ${(e as Error).message}`);
    return [];
  }
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function fetchLogFromUrl(url: string): string {
  // Try GitHub Actions run URL first: `gh run view --log <runId>`.
  const m = url.match(/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/);
  if (m) {
    try {
      return execFileSync('gh', ['run', 'view', '--log', m[1]], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    } catch (e) {
      throw new Error(`gh run view failed: ${(e as Error).message}. Ensure 'gh' is authenticated.`);
    }
  }
  throw new Error(`Unsupported URL shape (only GitHub Actions run URLs supported): ${url}`);
}

function loadLogText(logArg: string): { text: string; source: string } {
  if (logArg === '-') {
    const stdinText = readFileSync(0, 'utf-8');
    return { text: stdinText, source: 'stdin' };
  }
  if (isUrl(logArg)) {
    return { text: fetchLogFromUrl(logArg), source: logArg };
  }
  if (!existsSync(logArg)) {
    throw new Error(`Log file not found: ${logArg}`);
  }
  return { text: readFileSync(logArg, 'utf-8'), source: logArg };
}

// ── Rendering ───────────────────────────────────────────────────────────

function sevColor(sev: CiFailureSeverity): (s: string) => string {
  switch (sev) {
    case 'critical': return pc.red;
    case 'high': return pc.magenta;
    case 'medium': return pc.yellow;
    case 'low': return pc.blue;
    default: return (s) => s;
  }
}

function printReport(report: Report): void {
  console.log(pc.bold(`CI triage report — ${report.logSource}`));
  console.log(
    pc.dim(`  ${report.totalLines} total lines · ${report.errorLines} error-ish lines · ${report.clusters.length} clusters`),
  );
  console.log('');

  if (report.clusters.length === 0) {
    warn('No known failure patterns matched.');
    if (report.unknownExcerpt.length > 0) {
      console.log(pc.bold('Unclassified error lines (first 5):'));
      for (const line of report.unknownExcerpt.slice(0, 5)) {
        console.log(`  ${pc.dim(line)}`);
      }
    }
    return;
  }

  for (const c of report.clusters) {
    const color = sevColor(c.severity);
    console.log(`${color(pc.bold(c.severity.toUpperCase().padEnd(8)))} ${pc.bold(c.pattern)} × ${c.count}`);
    console.log(`  ${pc.dim(`lines ${c.firstLine}–${c.lastLine} · confidence ${c.confidence.toFixed(2)}`)}`);
    console.log(`  ${pc.cyan('fix:')} ${c.suggestedFix}`);
    for (const ex of c.examples) {
      console.log(`  ${pc.dim('│')} ${ex}`);
    }
    console.log('');
  }
}

// ── Persistence (mirror of ci-triage-store) ─────────────────────────────

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, path);
}

function saveReport(project: string, report: Report, ciRunId?: string): string {
  const baseDir = join(getAnvilHome(), 'ci-triage', project, 'records');
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const id = `ci-triage-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const rec = {
    id,
    project,
    ciRunId,
    createdAt: new Date().toISOString(),
    report,
  };
  const recordPath = join(baseDir, `${id}.json`);
  atomicWrite(recordPath, JSON.stringify(rec, null, 2));

  // Update index.json (best-effort).
  const indexPath = join(getAnvilHome(), 'ci-triage', project, 'index.json');
  let index: Array<{ id: string; createdAt: string; topPattern?: CiFailurePattern; topSeverity?: CiFailureSeverity; ciRunId?: string }> = [];
  if (existsSync(indexPath)) {
    try { index = JSON.parse(readFileSync(indexPath, 'utf-8')); } catch { /* ignore */ }
  }
  const top = report.clusters[0];
  index.push({
    id,
    createdAt: rec.createdAt,
    ...(top ? { topPattern: top.pattern, topSeverity: top.severity } : {}),
    ...(ciRunId ? { ciRunId } : {}),
  });
  index.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  atomicWrite(indexPath, JSON.stringify(index, null, 2));

  return id;
}

// ── Command ─────────────────────────────────────────────────────────────

export const triageCommand = new Command('triage')
  .description('Cluster a CI log into root-cause buckets and print top failures.')
  .argument('<logArg>', 'Path to a local log file, "-" for stdin, or a GitHub Actions run URL')
  .option('--project <slug>', 'Project slug (required when using --save)')
  .option('--save', 'Persist the report to ~/.anvil/ci-triage/<project>/', false)
  .option('--run-id <id>', 'CI run id to record alongside the report')
  .option('--json', 'Emit the full report as JSON instead of pretty output', false)
  .action(async (logArg: string, opts: { project?: string; save?: boolean; runId?: string; json?: boolean }) => {
    try {
      const extra = loadExtraPatterns(opts.project);
      if (extra.length > 0) info(`Loaded ${extra.length} custom pattern(s) from project config.`);

      const { text, source } = loadLogText(logArg);
      const report = cluster(text, source, extra);

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        printReport(report);
      }

      if (opts.save) {
        if (!opts.project) {
          error('--save requires --project <slug>.');
          process.exitCode = 1;
          return;
        }
        const id = saveReport(opts.project, report, opts.runId);
        success(`Saved triage record: ${id}`);
      }
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
