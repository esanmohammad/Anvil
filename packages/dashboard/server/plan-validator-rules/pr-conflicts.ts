/**
 * PR conflicts rule — flags plans that touch files currently being modified in
 * open PRs. Uses the `gh` CLI; silent + cache-friendly to avoid rate limits.
 */

import { execFileSync } from 'node:child_process';
import type { Plan } from '../plan-store.js';
import type { PlanIssue } from '../plan-validator.js';

interface GhPr {
  number: number;
  title: string;
  headRefName: string;
  url: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const prListCache = new Map<string, { at: number; prs: GhPr[] }>();
const prFilesCache = new Map<string, { at: number; files: string[] }>();

function cachedListPrs(repoFullName: string): GhPr[] {
  const hit = prListCache.get(repoFullName);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.prs;
  try {
    const out = execFileSync('gh', [
      'pr', 'list', '-R', repoFullName, '--state', 'open',
      '--json', 'number,title,headRefName,url',
      '--limit', '50',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    const prs = JSON.parse(out) as GhPr[];
    prListCache.set(repoFullName, { at: Date.now(), prs });
    return prs;
  } catch {
    return [];
  }
}

function cachedPrFiles(repoFullName: string, prNumber: number): string[] {
  const key = `${repoFullName}#${prNumber}`;
  const hit = prFilesCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;
  try {
    const out = execFileSync('gh', [
      'pr', 'view', String(prNumber), '-R', repoFullName,
      '--json', 'files',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    const parsed = JSON.parse(out) as { files: Array<{ path: string }> };
    const files = (parsed.files ?? []).map((f) => f.path);
    prFilesCache.set(key, { at: Date.now(), files });
    return files;
  } catch {
    return [];
  }
}

export interface PRConflictRuleDeps {
  /** Map from repo name (as referenced in the plan) to GitHub owner/repo. */
  githubByRepoName: Record<string, string>;
}

/**
 * Returns warnings for every overlap between plan-claimed files and open-PR
 * files, one issue per conflicting PR × repo.
 */
export function checkPrConflicts(plan: Plan, deps: PRConflictRuleDeps): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (let i = 0; i < plan.repos.length; i++) {
    const repo = plan.repos[i];
    // Plan v2: claimed paths come from mustTouch + mustExist.
    const claimedPaths: string[] = [
      ...(repo.mustTouch ?? []).map((c) => c.path).filter(Boolean),
      ...(repo.mustExist ?? []).map((c) => c.path).filter(Boolean),
    ];
    if (!claimedPaths.length) continue;
    const gh = deps.githubByRepoName[repo.name];
    if (!gh) continue;

    const prs = cachedListPrs(gh);
    for (const pr of prs) {
      const prFiles = cachedPrFiles(gh, pr.number);
      const conflicts = claimedPaths.filter((f: string) =>
        prFiles.some((p) => p === f || p.endsWith('/' + f)),
      );
      if (conflicts.length) {
        issues.push({
          severity: 'warn',
          path: `repos[${i}].mustTouch`,
          repo: repo.name,
          message: `Open PR #${pr.number} "${pr.title}" touches ${conflicts.length} of these files (${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? '…' : ''}). Coordinate or rebase before execute.`,
          hint: pr.url,
        });
      }
    }
  }
  return issues;
}

export function invalidatePrConflictCache(): void {
  prListCache.clear();
  prFilesCache.clear();
}
