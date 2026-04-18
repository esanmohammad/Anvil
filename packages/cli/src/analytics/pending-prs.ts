// Pending PR collector — Wave 9, Section D
// Checks PR status via gh CLI

import { execSync } from 'node:child_process';
import type { RunRecord } from '../run/types.js';

export interface PendingPR {
  url: string;
  runId: string;
  project: string;
  state: 'open' | 'closed' | 'merged' | 'unknown';
  title: string;
  checks: 'passing' | 'failing' | 'pending' | 'unknown';
}

/**
 * Parse gh pr view JSON output.
 */
function parsePrStatus(prUrl: string): { state: string; title: string; checks: string } {
  try {
    const output = execSync(
      `gh pr view "${prUrl}" --json state,title,statusCheckRollup`,
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    const data = JSON.parse(output);
    const state = (data.state ?? 'unknown').toLowerCase();
    const title = data.title ?? '';

    // Determine check status from statusCheckRollup
    const checks = data.statusCheckRollup ?? [];
    let checkStatus = 'unknown';
    if (Array.isArray(checks) && checks.length > 0) {
      const allPassing = checks.every(
        (c: any) => c.conclusion === 'SUCCESS' || c.status === 'COMPLETED',
      );
      const anyFailing = checks.some(
        (c: any) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR',
      );
      const anyPending = checks.some(
        (c: any) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED',
      );

      if (allPassing) checkStatus = 'passing';
      else if (anyFailing) checkStatus = 'failing';
      else if (anyPending) checkStatus = 'pending';
    }

    return { state, title, checks: checkStatus };
  } catch {
    return { state: 'unknown', title: '', checks: 'unknown' };
  }
}

/**
 * Collect pending PR statuses from run records that have prUrls.
 */
export function collectPendingPrs(runs: RunRecord[]): PendingPR[] {
  const results: PendingPR[] = [];

  for (const run of runs) {
    if (!run.prUrls || run.prUrls.length === 0) continue;

    for (const url of run.prUrls) {
      const { state, title, checks } = parsePrStatus(url);
      results.push({
        url,
        runId: run.id,
        project: run.project,
        state: state as PendingPR['state'],
        title,
        checks: checks as PendingPR['checks'],
      });
    }
  }

  return results;
}
