// Fix pipeline — Wave 9, Section A
// Abbreviated pipeline for bug fixes: analyze -> fix -> test -> PR

import { buildBugAnalysisPrompt } from './bug-analysis-prompt.js';
import { executeFix } from './fix-executor.js';
import type { BugAnalysisInput } from './bug-analysis-prompt.js';
import type { FixResult } from './fix-executor.js';

export interface FixPipelineConfig {
  project: string;
  bugDescription: string;
  repos: Array<{ name: string; path: string }>;
  conventions?: string;
  recentMemories?: string[];
  branchPrefix?: string;
}

export interface FixPipelineResult {
  status: 'success' | 'partial' | 'failed';
  analysisPrompt: string;
  results: FixResult[];
  totalRepos: number;
  successCount: number;
}

function generateBranchName(prefix: string, bugDesc: string): string {
  const slug = bugDesc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${prefix}/${slug}`;
}

/**
 * Run the abbreviated fix pipeline.
 * Skips clarify/requirements/spec stages — goes straight to
 * analyze -> fix -> test -> PR.
 */
export async function runFixPipeline(config: FixPipelineConfig): Promise<FixPipelineResult> {
  const branchPrefix = config.branchPrefix ?? 'fix';

  // Step 1: Build analysis prompt
  const analysisInput: BugAnalysisInput = {
    project: config.project,
    bugDescription: config.bugDescription,
    repos: config.repos.map((r) => r.name),
    conventions: config.conventions,
    recentMemories: config.recentMemories,
  };
  const analysisPrompt = buildBugAnalysisPrompt(analysisInput);

  // Step 2: Execute fix for each repo
  const branchName = generateBranchName(branchPrefix, config.bugDescription);
  const results: FixResult[] = [];

  for (const repo of config.repos) {
    const result = await executeFix({
      repoPath: repo.path,
      repoName: repo.name,
      branchName,
      bugDescription: config.bugDescription,
      analysisReport: analysisPrompt,
      workingDir: repo.path,
    });
    results.push(result);
  }

  // Step 3: Compute overall status
  const successCount = results.filter((r) => r.success).length;
  let status: FixPipelineResult['status'];
  if (successCount === config.repos.length) {
    status = 'success';
  } else if (successCount > 0) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  return {
    status,
    analysisPrompt,
    results,
    totalRepos: config.repos.length,
    successCount,
  };
}
