/**
 * test-checks-publisher — posts a TestRun's findings to GitHub as a single
 * Checks run with inline annotations on the PR diff.
 *
 * GitHub's Checks API accepts up to 50 annotations per create/patch request,
 * so for large runs we create the check with the first 50 and PATCH additional
 * batches onto the same check-run id. The GH API appends rather than replaces
 * annotations across PATCH calls.
 *
 * Each check-run's summary carries an idempotency marker
 * `<!-- anvil-test-run:${run.id} -->` so repeat publishes for the same
 * (repo, headSha, run.id) tuple update the existing check instead of piling
 * up side-by-side runs.
 *
 * Mirrors the style of `review-publisher.ts`: every `gh` invocation is
 * wrapped, failures are collected into the returned result, and the function
 * never throws.
 */

import { execSync } from 'node:child_process';
import type {
  TestRun,
  TestFinding,
  TestSpec,
  TestSeverity,
  TestCategory,
} from './test-types.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface PublishChecksOptions {
  /** `"owner/repo"` */
  repo: string;
  /** Commit SHA the check attaches to. */
  headSha: string;
  spec: TestSpec;
  run: TestRun;
  /** Optional filter — only publish findings at or above this severity. */
  minSeverity?: TestSeverity;
}

export interface PublishChecksResult {
  checkRunId: number;
  checkRunUrl: string;
  annotationsPosted: number;
  summary: string;
  errors: string[];
}

/** GitHub limits the Checks API to 50 annotations per request. */
const GH_ANNOTATION_BATCH_SIZE = 50;

/** Marker embedded in the check summary for idempotent re-publishing. */
const MARKER_PREFIX = '<!-- anvil-test-run:';

/** Severity ordering: higher index == higher severity. */
const SEVERITY_ORDER: TestSeverity[] = ['nit', 'info', 'warn', 'error', 'blocker'];

export async function publishTestChecks(opts: PublishChecksOptions): Promise<PublishChecksResult> {
  const { repo, headSha, spec, run } = opts;
  const minSeverity: TestSeverity = opts.minSeverity ?? 'info';

  const result: PublishChecksResult = {
    checkRunId: 0,
    checkRunUrl: '',
    annotationsPosted: 0,
    summary: '',
    errors: [],
  };

  // 1. Build the filtered + sorted annotation list.
  const annotations = buildAnnotations(run.findings, minSeverity);

  // 2. Build the summary markdown (embeds the idempotency marker).
  const summaryMarkdown = buildSummaryMarkdown(spec, run, annotations.length);
  result.summary = summaryMarkdown;

  const conclusion = computeConclusion(run);
  const title = buildSummaryTitle(run);

  // 3. Look for an existing check-run for this (repo, headSha, run.id).
  const existing = await findExistingCheckRun(repo, headSha, run.id, result.errors);

  const firstBatch = annotations.slice(0, GH_ANNOTATION_BATCH_SIZE);
  const remaining = annotations.slice(GH_ANNOTATION_BATCH_SIZE);

  // 4. Either PATCH the existing run or POST a new one with the first batch.
  let checkRunId = 0;
  let checkRunUrl = '';

  if (existing) {
    const patched = await patchCheckRun(repo, existing.id, {
      status: 'completed',
      conclusion,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      output: {
        title,
        summary: summaryMarkdown,
        annotations: firstBatch,
      },
    }, result.errors);
    if (patched) {
      checkRunId = patched.id;
      checkRunUrl = patched.html_url;
      result.annotationsPosted += firstBatch.length;
    }
  } else {
    const created = await createCheckRun(repo, {
      name: 'Anvil Test Review',
      head_sha: headSha,
      status: 'completed',
      conclusion,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      output: {
        title,
        summary: summaryMarkdown,
        annotations: firstBatch,
      },
    }, result.errors);
    if (created) {
      checkRunId = created.id;
      checkRunUrl = created.html_url;
      result.annotationsPosted += firstBatch.length;
    }
  }

  // If we couldn't create/patch, bail with whatever we have.
  if (!checkRunId) {
    return result;
  }

  result.checkRunId = checkRunId;
  result.checkRunUrl = checkRunUrl;

  // 5. PATCH remaining annotation batches (GH concatenates across PATCHes).
  for (let i = 0; i < remaining.length; i += GH_ANNOTATION_BATCH_SIZE) {
    const batch = remaining.slice(i, i + GH_ANNOTATION_BATCH_SIZE);
    const ok = await patchCheckRun(repo, checkRunId, {
      output: {
        title,
        summary: summaryMarkdown,
        annotations: batch,
      },
    }, result.errors);
    if (ok) {
      result.annotationsPosted += batch.length;
    }
  }

  return result;
}

// ── Annotation building ─────────────────────────────────────────────────

interface GhAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title: string;
}

function buildAnnotations(findings: TestFinding[], minSeverity: TestSeverity): GhAnnotation[] {
  const minRank = SEVERITY_ORDER.indexOf(minSeverity);
  const out: GhAnnotation[] = [];
  for (const f of findings) {
    if (!f.file || typeof f.line !== 'number') continue;
    const rank = SEVERITY_ORDER.indexOf(f.severity);
    if (rank < minRank) continue;
    out.push({
      path: f.file,
      start_line: f.line,
      end_line: f.line,
      annotation_level: mapAnnotationLevel(f.severity),
      message: truncate(f.description, 65535),
      title: truncate(`${f.severity} (${f.category})`, 255),
    });
  }
  // Sort by severity desc so the most important annotations land in the
  // first (guaranteed-posted) batch of 50.
  out.sort((a, b) => annotationRank(b) - annotationRank(a));
  return out;
}

function mapAnnotationLevel(sev: TestSeverity): 'notice' | 'warning' | 'failure' {
  switch (sev) {
    case 'blocker':
    case 'error':
      return 'failure';
    case 'warn':
      return 'warning';
    case 'info':
    case 'nit':
    default:
      return 'notice';
  }
}

function annotationRank(a: GhAnnotation): number {
  switch (a.annotation_level) {
    case 'failure': return 3;
    case 'warning': return 2;
    case 'notice':  return 1;
    default:        return 0;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

// ── Conclusion mapping ──────────────────────────────────────────────────

type Conclusion = 'success' | 'failure' | 'neutral' | 'skipped';

function computeConclusion(run: TestRun): Conclusion {
  if (run.status === 'error') return 'skipped';

  const hasErrorPlus = run.findings.some((f) => severityAtLeast(f.severity, 'error'));
  const hasWarnPlus = run.findings.some((f) => severityAtLeast(f.severity, 'warn'));

  if (run.verdict === 'fail' || hasErrorPlus) return 'failure';
  if (run.verdict === 'pass' && !hasWarnPlus) return 'success';
  // run.verdict === 'warn', or pass-but-with-low-severity findings.
  return 'neutral';
}

function severityAtLeast(sev: TestSeverity, floor: TestSeverity): boolean {
  return SEVERITY_ORDER.indexOf(sev) >= SEVERITY_ORDER.indexOf(floor);
}

// ── Summary markdown ────────────────────────────────────────────────────

function buildSummaryTitle(run: TestRun): string {
  const verdictLabel = run.verdict === 'pass' ? 'Passed' : run.verdict === 'warn' ? 'Warnings' : 'Failed';
  const total = run.results.length;
  const passed = run.results.filter((r) => r.pass).length;
  return `Anvil Test Review — ${verdictLabel} (${passed}/${total} cases)`;
}

function buildSummaryMarkdown(spec: TestSpec, run: TestRun, annotationCount: number): string {
  const counts = countBySeverity(run.findings);
  const catCounts = countByCategory(run.findings);
  const personaCounts = countByPersona(run.findings);
  const verdictEmoji = run.verdict === 'pass' ? '✅' : run.verdict === 'warn' ? '⚠️' : '❌';
  const verdictLabel = run.verdict === 'pass' ? 'Passed' : run.verdict === 'warn' ? 'Warnings' : 'Failed';

  const total = run.results.length;
  const passed = run.results.filter((r) => r.pass).length;
  const failed = total - passed;

  const lines: string[] = [];
  lines.push(`${MARKER_PREFIX}${run.id} -->`);
  lines.push(`## ${verdictEmoji} Anvil Test Review — ${verdictLabel}`);
  lines.push('');
  lines.push(`Run \`${run.id}\` for spec \`${spec.slug}\` v${spec.version} (trigger: ${run.trigger}).`);
  lines.push('');

  // Result table
  lines.push('| Cases | Passed | Failed | Quarantined | Findings |');
  lines.push('|:--|:--|:--|:--|:--|');
  lines.push(`| ${total} | ${passed} | ${failed} | ${run.flakyQuarantined.length} | ${run.findings.length} |`);
  lines.push('');

  // Severity table
  lines.push('**Findings by severity**');
  lines.push('');
  lines.push('| Blocker | Error | Warn | Info | Nit |');
  lines.push('|:--|:--|:--|:--|:--|');
  lines.push(`| ${counts.blocker} | ${counts.error} | ${counts.warn} | ${counts.info} | ${counts.nit} |`);
  lines.push('');

  // Coverage + mutation (if present)
  if (run.coverage) {
    lines.push('### Coverage');
    const delta = run.coverage.delta;
    const deltaLine = delta
      ? ` (Δ lines ${signed(delta.lines)}%, branches ${signed(delta.branches)}%)`
      : '';
    lines.push(
      `- Lines: **${pct(run.coverage.lines)}** · Branches: **${pct(run.coverage.branches)}** · Statements: **${pct(run.coverage.statements)}**${deltaLine}`,
    );
    lines.push('');
  }
  if (run.mutationScore) {
    lines.push('### Mutation score');
    lines.push(
      `- Score: **${pct(run.mutationScore.score)}** (${run.mutationScore.killed}/${run.mutationScore.total} killed)`,
    );
    lines.push('');
  }

  // Per-category breakdown
  const catEntries = Object.entries(catCounts).filter(([, n]) => n > 0);
  if (catEntries.length) {
    lines.push('### Findings by category');
    for (const [cat, n] of catEntries) {
      lines.push(`- **${cat}**: ${n}`);
    }
    lines.push('');
  }

  // Per-persona breakdown
  const personaEntries = Object.entries(personaCounts).filter(([, n]) => n > 0);
  if (personaEntries.length) {
    lines.push('### Persona contributions');
    for (const [persona, n] of personaEntries) {
      lines.push(`- ${persona}: ${n}`);
    }
    lines.push('');
  }

  // Top findings listing per category
  const byCat: Record<string, TestFinding[]> = {};
  for (const f of run.findings) {
    (byCat[f.category] ??= []).push(f);
  }
  if (Object.keys(byCat).length) {
    lines.push('### Top findings');
    for (const [cat, fs] of Object.entries(byCat)) {
      const sorted = [...fs].sort((a, b) =>
        SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity),
      );
      lines.push(`**${cat}** (${fs.length})`);
      for (const f of sorted.slice(0, 5)) {
        const loc = f.file && f.line ? `\`${f.file}:${f.line}\`` : '_(no location)_';
        lines.push(`- ${severityMarker(f.severity)} ${loc} — ${f.description}`);
      }
      if (fs.length > 5) {
        lines.push(`- _…and ${fs.length - 5} more_`);
      }
    }
    lines.push('');
  }

  if (annotationCount === 0) {
    lines.push('_No inline annotations were attached (no findings with a resolvable file+line)._');
    lines.push('');
  } else {
    lines.push(`_${annotationCount} inline annotation${annotationCount === 1 ? '' : 's'} attached to the diff._`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `🤖 Generated by Anvil · Spec \`${spec.slug}\` v${spec.version} · Run \`${run.id}\` · Model: ${spec.model}`,
  );

  return lines.join('\n');
}

function severityMarker(s: TestSeverity): string {
  return ({ blocker: '🛑', error: '❌', warn: '⚠️', info: 'ℹ️', nit: '💭' } as const)[s];
}

function countBySeverity(findings: TestFinding[]): Record<TestSeverity, number> {
  const out: Record<TestSeverity, number> = { blocker: 0, error: 0, warn: 0, info: 0, nit: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

function countByCategory(findings: TestFinding[]): Record<TestCategory, number> {
  const out: Record<TestCategory, number> = {
    coverage: 0,
    'edge-case': 0,
    security: 0,
    perf: 0,
    flakiness: 0,
    convention: 0,
  };
  for (const f of findings) out[f.category]++;
  return out;
}

function countByPersona(findings: TestFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    if (!f.persona) continue;
    out[f.persona] = (out[f.persona] ?? 0) + 1;
  }
  return out;
}

function pct(n: number): string {
  const v = n > 1 ? n : n * 100;
  return `${v.toFixed(1)}%`;
}

function signed(n: number): string {
  const v = n > -1 && n < 1 ? n * 100 : n;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

// ── GitHub API via gh CLI ────────────────────────────────────────────────

interface CheckRunResponse {
  id: number;
  html_url: string;
}

/**
 * Run `gh api` with a JSON body piped on stdin. Returns stdout on success;
 * throws on non-zero exit (caller catches and pushes into result.errors).
 */
function ghApi(args: string[], body?: unknown): string {
  // Always use `--input -` when a body is supplied; `gh api` reads that as
  // the raw request body rather than form fields.
  const fullArgs = body === undefined ? args : [...args, '--input', '-'];

  try {
    return execSync(['gh', 'api', ...fullArgs.map(quoteShellArg)].join(' '), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: body === undefined ? undefined : JSON.stringify(body),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes('command not found') || msg.includes('ENOENT')) {
      throw new Error('`gh` CLI not found. Install from cli.github.com and run `gh auth login`.');
    }
    throw err;
  }
}

/**
 * Quote a shell argument for safe concatenation. Argument list is built by
 * this module so we only need POSIX single-quote escaping.
 */
function quoteShellArg(arg: string): string {
  if (arg === '' ) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function createCheckRun(
  repo: string,
  body: Record<string, unknown>,
  errors: string[],
): Promise<CheckRunResponse | null> {
  try {
    const out = ghApi(['-X', 'POST', `/repos/${repo}/check-runs`], body);
    const parsed = JSON.parse(out) as Partial<CheckRunResponse>;
    if (typeof parsed.id !== 'number' || typeof parsed.html_url !== 'string') {
      errors.push('Create check-run: unexpected response shape from gh.');
      return null;
    }
    return { id: parsed.id, html_url: parsed.html_url };
  } catch (err) {
    errors.push(`Create check-run failed: ${errorMessage(err)}`);
    return null;
  }
}

async function patchCheckRun(
  repo: string,
  checkRunId: number,
  body: Record<string, unknown>,
  errors: string[],
): Promise<CheckRunResponse | null> {
  try {
    const out = ghApi(['-X', 'PATCH', `/repos/${repo}/check-runs/${checkRunId}`], body);
    const parsed = JSON.parse(out) as Partial<CheckRunResponse>;
    if (typeof parsed.id !== 'number' || typeof parsed.html_url !== 'string') {
      // PATCH succeeded but response unrecognised — keep going using the
      // id/url the caller already had.
      return { id: checkRunId, html_url: '' };
    }
    return { id: parsed.id, html_url: parsed.html_url };
  } catch (err) {
    errors.push(`Patch check-run ${checkRunId} failed: ${errorMessage(err)}`);
    return null;
  }
}

interface ExistingCheck {
  id: number;
  url: string;
}

async function findExistingCheckRun(
  repo: string,
  headSha: string,
  runId: string,
  errors: string[],
): Promise<ExistingCheck | null> {
  try {
    // Ask gh to paginate and project to the fields we care about.
    const out = ghApi([
      `/repos/${repo}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq', '.check_runs[] | {id, html_url, output_summary: .output.summary}',
    ]);
    const marker = `${MARKER_PREFIX}${runId} -->`;
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { id: number; html_url: string; output_summary?: string | null };
        if (typeof row.output_summary === 'string' && row.output_summary.includes(marker)) {
          return { id: row.id, url: row.html_url };
        }
      } catch {
        // Ignore malformed rows — we'll just fall through to create a new run.
      }
    }
    return null;
  } catch (err) {
    // Not fatal — if we can't list existing runs we fall back to creating
    // a new one. Capture the error so the caller can surface it.
    errors.push(`List existing check-runs failed: ${errorMessage(err)}`);
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
