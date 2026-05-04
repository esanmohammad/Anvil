/**
 * review-github-annotator — post review findings as inline PR comments.
 * Dedupes by marker; updates in place on re-run.
 */

import { execFileSync } from 'node:child_process';
import {
  parsePrUrl,
  buildBannerBody,
  buildFindingBody,
  listPrCommentsWithMarker,
  listIssueCommentsWithMarker,
  BANNER_MARKER,
  FINDING_MARKER_PREFIX,
  type FindingLike,
  type BannerCounts,
} from './review-github-annotator-helpers.js';

export interface ReviewAnnotation extends FindingLike {}

export interface PostAnnotationsResult {
  posted: number;
  updated: number;
  skipped: number;
  errors: Array<{ findingId: string; error: string }>;
}

function tryGh(args: string[]): { ok: true; stdout: string } | { ok: false; err: string } {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, err: err instanceof Error ? err.message : String(err) };
  }
}

function summarizeCounts(annotations: ReviewAnnotation[]): BannerCounts {
  const c: BannerCounts = { total: annotations.length, blocker: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const a of annotations) c[a.severity] += 1;
  return c;
}

async function getLatestCommitSha(owner: string, repo: string, number: number): Promise<string | null> {
  const r = tryGh(['api', `/repos/${owner}/${repo}/pulls/${number}`]);
  if (!r.ok) return null;
  try {
    const json = JSON.parse(r.stdout) as { head?: { sha?: string } };
    return json.head?.sha ?? null;
  } catch { return null; }
}

async function listDiffFiles(owner: string, repo: string, number: number): Promise<Set<string>> {
  const r = tryGh(['api', '--paginate', `/repos/${owner}/${repo}/pulls/${number}/files`]);
  if (!r.ok) return new Set();
  try {
    const json = JSON.parse(r.stdout) as Array<{ filename: string }>;
    return new Set(json.map((f) => f.filename));
  } catch { return new Set(); }
}

export async function postReviewAnnotations(input: {
  prUrl: string;
  annotations: ReviewAnnotation[];
  verdictHeadline: string;
  verdictLevel: 'approve' | 'needs-changes' | 'blocker';
  dashboardBaseUrl?: string;
}): Promise<PostAnnotationsResult> {
  const parsed = parsePrUrl(input.prUrl);
  if (!parsed) {
    return { posted: 0, updated: 0, skipped: 0, errors: [{ findingId: '_', error: 'invalid PR URL' }] };
  }
  const { owner, repo, number } = parsed;
  const result: PostAnnotationsResult = { posted: 0, updated: 0, skipped: 0, errors: [] };

  // Banner: top-level issue comment summarising the verdict.
  const counts = summarizeCounts(input.annotations);
  const bannerBody = buildBannerBody(input.verdictLevel, input.verdictHeadline, counts);
  const bannerExisting = await listIssueCommentsWithMarker(input.prUrl, BANNER_MARKER);
  if (bannerExisting.length > 0) {
    const r = tryGh(['api', '--method', 'PATCH', `/repos/${owner}/${repo}/issues/comments/${bannerExisting[0].id}`,
      '-f', `body=${bannerBody}`]);
    if (!r.ok) result.errors.push({ findingId: '_banner', error: r.err });
    else result.updated += 1;
  } else {
    const r = tryGh(['api', '--method', 'POST', `/repos/${owner}/${repo}/issues/${number}/comments`,
      '-f', `body=${bannerBody}`]);
    if (!r.ok) result.errors.push({ findingId: '_banner', error: r.err });
    else result.posted += 1;
  }

  const commit = await getLatestCommitSha(owner, repo, number);
  const diffFiles = await listDiffFiles(owner, repo, number);
  if (!commit) {
    result.errors.push({ findingId: '_pr', error: 'could not resolve PR head SHA' });
    return result;
  }

  for (const ann of input.annotations) {
    if (!diffFiles.has(ann.filePath)) { result.skipped += 1; continue; }
    const body = buildFindingBody(ann, input.verdictLevel, input.dashboardBaseUrl);
    const marker = `${FINDING_MARKER_PREFIX}${ann.findingId}`;
    const existing = await listPrCommentsWithMarker(input.prUrl, marker);
    if (existing.length > 0) {
      const r = tryGh(['api', '--method', 'PATCH', `/repos/${owner}/${repo}/pulls/comments/${existing[0].id}`,
        '-f', `body=${body}`]);
      if (!r.ok) result.errors.push({ findingId: ann.findingId, error: r.err });
      else result.updated += 1;
    } else {
      const r = tryGh(['api', '--method', 'POST', `/repos/${owner}/${repo}/pulls/${number}/comments`,
        '-f', `body=${body}`, '-f', `commit_id=${commit}`, '-f', `path=${ann.filePath}`,
        '-F', `line=${ann.line}`, '-f', 'side=RIGHT']);
      if (!r.ok) result.errors.push({ findingId: ann.findingId, error: r.err });
      else result.posted += 1;
    }
  }

  return result;
}
