/**
 * `fix` step factory — runs an engineer agent against a bug description.
 *
 * Phase H3 — promoted from `packages/dashboard/server/steps/fix.step.ts`
 * with signature refactored to take an `AgentRunner`. Composes with
 * `validate.step` and `fix-loop.step` for the multi-stage Fix flow.
 *
 * Per-repo fan-out when `repoNames.length > 0`, else single-workspace.
 */

import type { AgentRunner } from '../agent-runner.js';

export interface RunFixOptions {
  runner: AgentRunner;
  project: string;
  /** Bug description from the user — becomes the agent's prompt. */
  description: string;
  /** Resolved model id. */
  model: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  /** Builds the project (system) prompt. */
  buildProjectPrompt: () => string;
  /** Builds the per-repo project (system) prompt. */
  buildRepoProjectPrompt: (repoName: string) => string;
  maxOutputTokens?: number;
  /** Per-stage allow list. Fix needs read+write+exec. */
  allowedTools?: string[];
}

export interface RunFixResult {
  /** Combined fix output across all repos (single-workspace: that one agent's output). */
  artifact: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Per-repo agent ids — used by fix-loop to resume sessions on retry. */
  agentIds: Map<string, string>;
  /** Single-workspace agent id (null on per-repo path). */
  singleAgentId: string | null;
}

const SHARED_PROMPT_HEADER =
  `Diagnose and fix the bug described below. Apply the minimal change that\n` +
  `resolves the issue. Run the relevant tests to confirm the fix. Do NOT make\n` +
  `git commits — the validate stage will check your work, and a follow-up\n` +
  `stage handles git operations if any are needed.\n\n`;

export async function runFix(opts: RunFixOptions): Promise<RunFixResult> {
  if (opts.repoNames.length === 0) {
    const prompt = `${SHARED_PROMPT_HEADER}Bug:\n${opts.description}`;
    const result = await opts.runner.run({
      persona: 'engineer',
      stage: 'fix',
      projectPrompt: opts.buildProjectPrompt(),
      userPrompt: prompt,
      workingDir: opts.workspaceDir,
      model: opts.model,
      allowedTools: opts.allowedTools,
      maxOutputTokens: opts.maxOutputTokens,
    });
    return {
      artifact: result.output,
      cost: result.costUsd ?? 0,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens ?? 0,
      cacheWriteTokens: result.cacheWriteTokens ?? 0,
      agentIds: new Map(),
      singleAgentId: result.agentId ?? null,
    };
  }

  const agentIds = new Map<string, string>();

  const promises = opts.repoNames.map(async (repoName) => {
    const repoPath = opts.repoPaths[repoName] ?? opts.workspaceDir;
    const prompt =
      `${SHARED_PROMPT_HEADER}Target repo: "${repoName}"\n\nBug:\n${opts.description}\n\n` +
      `Stay within the bounds of this repository.`;
    const result = await opts.runner.run({
      persona: 'engineer',
      stage: 'fix',
      repoName,
      projectPrompt: opts.buildRepoProjectPrompt(repoName),
      userPrompt: prompt,
      workingDir: repoPath,
      model: opts.model,
      allowedTools: opts.allowedTools,
      maxOutputTokens: opts.maxOutputTokens,
    });
    if (result.agentId) agentIds.set(repoName, result.agentId);
    return {
      repoName,
      artifact: result.output,
      cost: result.costUsd ?? 0,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens ?? 0,
      cacheWriteTokens: result.cacheWriteTokens ?? 0,
    };
  });

  const results = await Promise.all(promises);
  const combined = results
    .map((r) => `## ${r.repoName}\n\n${r.artifact}`)
    .join('\n\n');
  return {
    artifact: combined,
    cost: results.reduce((s, r) => s + r.cost, 0),
    inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
    cacheReadTokens: results.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWriteTokens: results.reduce((s, r) => s + r.cacheWriteTokens, 0),
    agentIds,
    singleAgentId: null,
  };
}
