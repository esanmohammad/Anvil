/**
 * github-pr-annotator — shells out to the `gh` CLI to fetch PR diff stats and
 * post / edit a single deduped "anvil-regression-guard" markdown comment.
 */

import { execFileSync } from 'node:child_process';

import type { BoundAnnotation, PRDiffHunk } from './bound-tests-annotator.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface PRRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PostAnnotationsOptions {
  /** Skip network calls entirely — used by tests / dry-run. */
  dryRun?: boolean;
  /** Override the comment marker; exposed for tests. */
  marker?: string;
}

const DEFAULT_MARKER = '<!-- anvil-regression-guard -->';

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Return an array of `{ filePath, addedLines, removedLines }` for every file
 * in the PR. On failure (gh not installed / not authed / parse error) we log
 * to stderr and return an empty array rather than throwing.
 */
export function getPRDiffHunks(prUrl: string): PRDiffHunk[] {
  const ref = parsePrUrl(prUrl);
  if (!ref) {
    process.stderr.write(`[bound-tests] cannot parse PR URL: ${prUrl}\n`);
    return [];
  }

  const apiPath = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files`;
  let raw: string;
  try {
    raw = execFileSync('gh', ['api', '--paginate', apiPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logGhFailure('getPRDiffHunks', err);
    return [];
  }

  return parseFilesJson(raw);
}

/**
 * Post a single markdown comment summarising `annotations`. If a prior comment
 * bearing the dedupe marker is found it is edited in place; otherwise a new
 * comment is created. Empty annotation lists result in no-op (any pre-existing
 * marker comment stays untouched).
 */
export async function postAnnotations(
  prUrl: string,
  annotations: BoundAnnotation[],
  opts: PostAnnotationsOptions = {},
): Promise<void> {
  if (annotations.length === 0) return;

  const ref = parsePrUrl(prUrl);
  if (!ref) {
    process.stderr.write(`[bound-tests] cannot parse PR URL: ${prUrl}\n`);
    return;
  }

  const marker = opts.marker ?? DEFAULT_MARKER;
  const body = renderAnnotationsMarkdown(annotations, marker);

  if (opts.dryRun) {
    process.stderr.write(
      `[bound-tests] dry-run: would post ${annotations.length} annotation(s) to ${prUrl}\n`,
    );
    return;
  }

  const existingCommentId = findExistingCommentId(ref, marker);
  if (existingCommentId !== null) {
    try {
      execFileSync(
        'gh',
        [
          'api',
          '--method',
          'PATCH',
          `/repos/${ref.owner}/${ref.repo}/issues/comments/${existingCommentId}`,
          '-f',
          `body=${body}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return;
    } catch (err) {
      logGhFailure('postAnnotations (edit)', err);
      // Fall through and attempt a fresh comment.
    }
  }

  try {
    execFileSync('gh', ['pr', 'comment', prUrl, '--body', body], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    logGhFailure('postAnnotations (create)', err);
  }
}

// ── Internals ────────────────────────────────────────────────────────────

/**
 * Match both classic web URLs (https://github.com/o/r/pull/N) and the short
 * refs that `gh` emits (o/r#N).
 */
export function parsePrUrl(prUrl: string): PRRef | null {
  if (typeof prUrl !== 'string' || prUrl.length === 0) return null;
  const webMatch = prUrl.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i,
  );
  if (webMatch) {
    return { owner: webMatch[1], repo: webMatch[2], number: Number(webMatch[3]) };
  }
  const shortMatch = prUrl.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1],
      repo: shortMatch[2],
      number: Number(shortMatch[3]),
    };
  }
  return null;
}

interface GhFileEntry {
  filename?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

function parseFilesJson(raw: string): PRDiffHunk[] {
  // `gh api --paginate` concatenates JSON arrays without a separator between
  // pages. Split on "][" first and rejoin into a single array, then parse.
  const chunks = raw.trim().split(/\]\s*\[/);
  const out: PRDiffHunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
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
      const e = entry as GhFileEntry;
      if (typeof e.filename !== 'string') continue;
      const additions =
        typeof e.additions === 'number' && Number.isFinite(e.additions)
          ? e.additions
          : 0;
      const deletions =
        typeof e.deletions === 'number' && Number.isFinite(e.deletions)
          ? e.deletions
          : 0;
      out.push({
        filePath: e.filename,
        addedLines: additions,
        removedLines: deletions,
      });
    }
  }
  return out;
}

interface GhCommentEntry {
  id?: unknown;
  body?: unknown;
}

function findExistingCommentId(ref: PRRef, marker: string): number | null {
  let raw: string;
  try {
    raw = execFileSync(
      'gh',
      [
        'api',
        '--paginate',
        `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`,
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    logGhFailure('findExistingCommentId', err);
    return null;
  }

  const chunks = raw.trim().split(/\]\s*\[/);
  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];
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
      if (
        typeof c.body === 'string' &&
        c.body.includes(marker) &&
        typeof c.id === 'number' &&
        Number.isFinite(c.id)
      ) {
        return c.id;
      }
    }
  }
  return null;
}

export function renderAnnotationsMarkdown(
  annotations: BoundAnnotation[],
  marker: string = DEFAULT_MARKER,
): string {
  const blocks = Array.from(annotations).sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );
  const lines: string[] = [];
  lines.push(marker);
  lines.push('## Anvil Regression Guard');
  lines.push('');
  lines.push(
    'This PR touches files that guard known incidents. Please review carefully.',
  );
  lines.push('');
  for (const a of blocks) {
    const icon =
      a.severity === 'block' ? '⛔'
      : a.severity === 'warning' ? '⚠️'
      : 'ℹ️';
    lines.push(`### ${icon} \`${a.filePath}\``);
    lines.push(
      `- **Severity:** ${a.severity}`,
      `- **Incident:** ${a.incidentId}`,
      `- **Replay:** ${a.replayId}`,
      '',
      a.message,
      '',
    );
  }
  return lines.join('\n');
}

function logGhFailure(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[bound-tests] ${op} via gh CLI failed: ${msg}\n`);
}
