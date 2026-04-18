// Git drift detection — compares snapshot SHAs against current repo state

import { execGit } from '../git/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriftType = 'none' | 'fast-forward' | 'diverged';

export interface RepoDrift {
  repoName: string;
  snapshotSha: string | null;
  currentSha: string | null;
  drift: DriftType;
  recommendation: string;
}

export interface DriftReport {
  hasDrift: boolean;
  repos: RepoDrift[];
  projectYamlChanged: boolean;
  conventionsChanged: boolean;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

const RECOMMENDATIONS: Record<DriftType, string> = {
  none: 'No action needed',
  'fast-forward': 'Continue (new commits won\'t affect completed stages)',
  diverged: 'Consider aborting — repo has been rebased',
};

// ---------------------------------------------------------------------------
// Detect drift
// ---------------------------------------------------------------------------

export async function detectGitDrift(
  snapshot: {
    repoShas: Record<string, string | null>;
    projectYamlHash: string;
    conventionsHash: string | null;
  },
  repoPaths: Record<string, string>,
  currentProjectYamlHash: string,
  currentConventionsHash: string | null,
): Promise<DriftReport> {
  const repos: RepoDrift[] = [];

  for (const [repoName, snapshotSha] of Object.entries(snapshot.repoShas)) {
    const repoPath = repoPaths[repoName];

    // If we don't have a path for this repo, mark as diverged
    if (!repoPath) {
      repos.push({
        repoName,
        snapshotSha,
        currentSha: null,
        drift: snapshotSha ? 'diverged' : 'none',
        recommendation: snapshotSha
          ? RECOMMENDATIONS.diverged
          : RECOMMENDATIONS.none,
      });
      continue;
    }

    // Get current SHA
    let currentSha: string | null;
    try {
      const { stdout } = await execGit(repoPath, ['rev-parse', 'HEAD']);
      currentSha = stdout.trim();
    } catch {
      currentSha = null;
    }

    const drift = await classifyDrift(repoPath, snapshotSha, currentSha);

    repos.push({
      repoName,
      snapshotSha,
      currentSha,
      drift,
      recommendation: RECOMMENDATIONS[drift],
    });
  }

  const projectYamlChanged = snapshot.projectYamlHash !== currentProjectYamlHash;
  const conventionsChanged =
    snapshot.conventionsHash !== currentConventionsHash;

  const hasDrift =
    repos.some((r) => r.drift !== 'none') ||
    projectYamlChanged ||
    conventionsChanged;

  return {
    hasDrift,
    repos,
    projectYamlChanged,
    conventionsChanged,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function classifyDrift(
  repoPath: string,
  snapshotSha: string | null,
  currentSha: string | null,
): Promise<DriftType> {
  // Both null — no drift
  if (!snapshotSha && !currentSha) return 'none';

  // One is null but not the other
  if (!snapshotSha || !currentSha) return 'diverged';

  // Same SHA — no drift
  if (snapshotSha === currentSha) return 'none';

  // Check if snapshot is an ancestor of current (fast-forward)
  try {
    await execGit(repoPath, ['merge-base', '--is-ancestor', snapshotSha, currentSha]);
    // Exit code 0 means snapshotSha IS an ancestor of currentSha
    return 'fast-forward';
  } catch {
    // Non-zero exit: not an ancestor — diverged
    return 'diverged';
  }
}
