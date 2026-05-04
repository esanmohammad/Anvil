/**
 * review-github-annotator-helpers — parsing, body rendering, and `gh api` list
 * helpers for the Review Phase R11 PR annotator.
 *
 * Pure(-ish) helpers: no orchestration, no mutation. All `gh` failures are
 * caught and surfaced as empty results or logged to stderr. Tests shell out
 * through the `GH_STUB=1` env var hook in the companion file.
 */

import { execFileSync } from 'node:child_process';

// ── Shared marker constants ───────────────────────────────────────────────

export const BANNER_MARKER = '<!-- anvil-review-banner -->';
export const FINDING_MARKER_PREFIX = 'anvil-review:';

// ── Types ─────────────────────────────────────────────────────────────────

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ExistingComment {
  id: string;
  path: string;
  body: string;
}

export interface FindingLike {
  findingId: string;
  filePath: string;
  line: number;
  severity: 'blocker' | 'high' | 'medium' | 'low' | 'info';
  body: string;
}

export interface BannerCounts {
  total: number;
  blocker: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

// ── Public helpers ────────────────────────────────────────────────────────

/**
 * Accepts `https://github.com/o/r/pull/N` and the short form `o/r#N`. Returns
 * `null` for anything else — callers should treat a null return as "abort".
 */
export function parsePrUrl(url: string): PRRef | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const web = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (web) {
    return { owner: web[1], repo: web[2], number: Number(web[3]) };
  }
  const short = url.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  if (short) {
    return { owner: short[1], repo: short[2], number: Number(short[3]) };
  }
  return null;
}

/**
 * Build the banner markdown posted as a top-level issue comment summarising
 * the verdict.
 */
export function buildBannerBody(
  verdictLevel: 'approve' | 'needs-changes' | 'blocker',
  headline: string,
  counts: BannerCounts,
): string {
  const icon =
    verdictLevel === 'approve' ? '✅'
    : verdictLevel === 'needs-changes' ? '⚠️'
    : '⛔';
  const label =
    verdictLevel === 'approve' ? 'Approved'
    : verdictLevel === 'needs-changes' ? 'Needs changes'
    : 'Blocker';
  const lines: string[] = [];
  lines.push(BANNER_MARKER);
  lines.push(`## ${icon} Anvil Review — ${label}`);
  lines.push('');
  lines.push(headline);
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| ⛔ Blocker | ${counts.blocker} |`);
  lines.push(`| 🔴 High | ${counts.high} |`);
  lines.push(`| 🟠 Medium | ${counts.medium} |`);
  lines.push(`| 🟡 Low | ${counts.low} |`);
  lines.push(`| ℹ️ Info | ${counts.info} |`);
  lines.push('');
  lines.push(`_Total findings: ${counts.total}_`);
  return lines.join('\n');
}

/**
 * Render an individual finding into GitHub-flavored markdown. The marker line
 * at the top is what `postReviewAnnotations` searches for on re-runs to decide
 * between PATCH and POST.
 */
export function buildFindingBody(
  finding: FindingLike,
  verdictLevel: 'approve' | 'needs-changes' | 'blocker',
  deeplinkBase?: string,
): string {
  const badge = severityBadge(finding.severity);
  const lines: string[] = [];
  lines.push(`<!-- ${FINDING_MARKER_PREFIX}${finding.findingId} -->`);
  lines.push(`**${badge} ${finding.severity.toUpperCase()}** — Anvil Review`);
  lines.push('');
  // Quote the body so every line renders as a blockquote snippet in the PR UI.
  for (const raw of finding.body.split('\n')) {
    lines.push(`> ${raw}`);
  }
  lines.push('');
  if (deeplinkBase) {
    const sep = deeplinkBase.includes('?') ? '&' : '?';
    const link = `${deeplinkBase}${sep}finding=${encodeURIComponent(finding.findingId)}`;
    lines.push(`[Open in Anvil dashboard](${link})`);
  }
  lines.push('');
  lines.push(`_Overall verdict: ${verdictLevel}_`);
  return lines.join('\n');
}

/**
 * Fetch all inline review comments on a PR whose body contains `marker`.
 * Shells out to `gh api --paginate`. Never throws — logs and returns [].
 */
export async function listPrCommentsWithMarker(
  prUrl: string,
  marker: string,
): Promise<ExistingComment[]> {
  const ref = parsePrUrl(prUrl);
  if (!ref) return [];
  const apiPath = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`;
  let raw: string;
  try {
    raw = ghExec(['api', '--paginate', apiPath]);
  } catch (err) {
    logGhFailure('listPrCommentsWithMarker', err);
    return [];
  }
  return parseCommentsJson(raw).filter((c) => c.body.includes(marker));
}

/**
 * Fetch all top-level issue comments on the PR whose body contains `marker`.
 * Used to locate the banner. Never throws.
 */
export async function listIssueCommentsWithMarker(
  prUrl: string,
  marker: string,
): Promise<ExistingComment[]> {
  const ref = parsePrUrl(prUrl);
  if (!ref) return [];
  const apiPath = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`;
  let raw: string;
  try {
    raw = ghExec(['api', '--paginate', apiPath]);
  } catch (err) {
    logGhFailure('listIssueCommentsWithMarker', err);
    return [];
  }
  return parseCommentsJson(raw).filter((c) => c.body.includes(marker));
}

// ── Shell-out indirection (test-hook via GH_STUB=1) ──────────────────────

interface StubResponse {
  stdout?: string;
  exitCode?: number;
}

/**
 * Invoke `gh` with the given argv. When `GH_STUB=1` is set, reads canned
 * responses from `process.env.GH_STUB_MAP` (JSON: argv.join(' ') → response).
 */
export function ghExec(argv: string[]): string {
  if (process.env.GH_STUB === '1') {
    return stubbedGh(argv);
  }
  return execFileSync('gh', argv, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function stubbedGh(argv: string[]): string {
  const key = argv.join(' ');
  const raw = process.env.GH_STUB_MAP ?? '{}';
  let map: Record<string, StubResponse>;
  try {
    map = JSON.parse(raw) as Record<string, StubResponse>;
  } catch {
    map = {};
  }
  const match = map[key];
  if (!match) return '[]';
  if (typeof match.exitCode === 'number' && match.exitCode !== 0) {
    const err = new Error(`gh stub exit ${match.exitCode} for: ${key}`);
    throw err;
  }
  return match.stdout ?? '';
}

// ── Internals ────────────────────────────────────────────────────────────

interface GhCommentEntry {
  id?: unknown;
  path?: unknown;
  body?: unknown;
}

function parseCommentsJson(raw: string): ExistingComment[] {
  // `gh api --paginate` concatenates JSON arrays without a separator.
  const chunks = raw.trim().split(/\]\s*\[/);
  const out: ExistingComment[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (chunk.length === 0) continue;
    if (i > 0) chunk = '[' + chunk;
    if (i < chunks.length - 1) chunk = chunk + ']';
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const c = entry as GhCommentEntry;
      if (typeof c.body !== 'string') continue;
      const idStr =
        typeof c.id === 'number' && Number.isFinite(c.id) ? String(c.id)
        : typeof c.id === 'string' ? c.id
        : null;
      if (!idStr) continue;
      out.push({
        id: idStr,
        path: typeof c.path === 'string' ? c.path : '',
        body: c.body,
      });
    }
  }
  return out;
}

function severityBadge(
  severity: 'blocker' | 'high' | 'medium' | 'low' | 'info',
): string {
  switch (severity) {
    case 'blocker': return '⛔';
    case 'high': return '🔴';
    case 'medium': return '🟠';
    case 'low': return '🟡';
    case 'info': return 'ℹ️';
  }
}

function logGhFailure(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[review-github-annotator] ${op} via gh CLI failed: ${msg}\n`);
}
