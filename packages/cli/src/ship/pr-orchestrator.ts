// Orchestrate PR creation across multiple repos with cross-linking

import type { PrBodyContext } from './pr-body-builder.js';
import { buildPrBody } from './pr-body-builder.js';
import { createPr, type ExecCommand as PrExecCommand, type PrCreateResult } from './pr-creator.js';
import { addCrossLinks, type ExecCommand as LinkExecCommand } from './pr-cross-linker.js';

export interface RepoConfig {
  repo: string;
  branch: string;
  base?: string;
}

export interface OrchestratorResult {
  prs: Array<{ repo: string; result: PrCreateResult }>;
  crossLinked: boolean;
}

/**
 * Create PRs for all repos, then update each with cross-links to siblings.
 */
export async function createAllPrs(
  repos: RepoConfig[],
  context: PrBodyContext,
  execCommand?: PrExecCommand,
  labels?: string[],
): Promise<OrchestratorResult> {
  const prs: Array<{ repo: string; result: PrCreateResult }> = [];

  // Step 1: Create PRs for all repos
  for (const repoConfig of repos) {
    const body = buildPrBody(context);
    const result = await createPr(
      {
        repo: repoConfig.repo,
        branch: repoConfig.branch,
        title: `[FF] ${context.featureSlug}`,
        body,
        base: repoConfig.base,
        labels,
      },
      execCommand,
    );
    prs.push({ repo: repoConfig.repo, result });
  }

  // Step 2: Cross-link successful PRs
  const successfulPrs = prs.filter((p) => p.result.success);
  const allUrls = successfulPrs.map((p) => p.result.url);

  let crossLinked = false;
  if (allUrls.length > 1) {
    crossLinked = true;
    for (const pr of successfulPrs) {
      const siblings = allUrls.filter((url) => url !== pr.result.url);
      const linkResult = await addCrossLinks(
        pr.result.url,
        siblings,
        execCommand as LinkExecCommand | undefined,
      );
      if (!linkResult.success) {
        crossLinked = false;
      }
    }
  }

  return { prs, crossLinked };
}
