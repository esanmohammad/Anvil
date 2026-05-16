/**
 * `per-repo-stage` step factory + persona helpers.
 *
 * Phase H9 — promoted from
 * `packages/dashboard/server/steps/per-repo-stage.step.ts` into
 * `core-pipeline/src/steps`. Refactored to take an `AgentRunner`. The
 * persona-aware `disallowedToolsForPersona` helper lifts here too —
 * runners (`AgentManagerRunner`, `AgentManagerSession`) now import from
 * the canonical location.
 *
 * Helpers + factory exported:
 *   - `disallowedToolsForPersona(persona)` — per-persona tool gates
 *   - `runPerRepoStageForRepo(opts)` — single-repo run via AgentRunner
 *   - `combinePerRepoArtifacts(results)` — `## repo\n\nartifact` separator
 *   - `createPerRepoStageStep(opts)` — `parallelism: 'per-repo'` Step
 */

import type { Step, StepContext } from '../types.js';
import type { AgentRunner } from '../agent-runner.js';

const FILE_MUTATING_PERSONAS = new Set(['engineer', 'tester']);
const KB_ONLY_PERSONAS = new Set(['analyst', 'architect', 'lead']);

/**
 * Per-persona tool gates. Stable across stages:
 *  - engineer / tester: `Agent` blocked (P8 — sub-agents inherit context).
 *  - analyst / architect / lead: file-mutating + exploration tools blocked
 *    (the Knowledge Base injection makes Grep/Glob redundant for them).
 *  - default (clarifier, etc.): file-mutating tools blocked; Grep/Glob ok.
 */
export function disallowedToolsForPersona(persona: string): string[] {
  if (FILE_MUTATING_PERSONAS.has(persona)) {
    return ['Agent'];
  }
  if (KB_ONLY_PERSONAS.has(persona)) {
    return ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'Agent'];
  }
  return ['Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent'];
}

export interface RunPerRepoStageOptions {
  runner: AgentRunner;
  project: string;
  stageName: string;
  persona: string;
  model: string;
  maxOutputTokens?: number;
  repoName: string;
  repoPath: string;
  projectPrompt: string;
  prompt: string;
  allowedTools?: string[];
}

export interface RunPerRepoStageResult {
  agentId: string;
  artifact: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function runPerRepoStageForRepo(
  opts: RunPerRepoStageOptions,
): Promise<RunPerRepoStageResult> {
  const result = await opts.runner.run({
    persona: opts.persona,
    stage: opts.stageName,
    repoName: opts.repoName,
    projectPrompt: opts.projectPrompt,
    userPrompt: opts.prompt,
    workingDir: opts.repoPath,
    model: opts.model,
    allowedTools: opts.allowedTools,
    disallowedTools: disallowedToolsForPersona(opts.persona),
    maxOutputTokens: opts.maxOutputTokens,
  });
  return {
    agentId: result.agentId ?? '',
    artifact: result.output,
    cost: result.costUsd ?? 0,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    cacheReadTokens: result.cacheReadTokens ?? 0,
    cacheWriteTokens: result.cacheWriteTokens ?? 0,
  };
}

export function combinePerRepoArtifacts(
  results: ReadonlyArray<{ repoName: string; artifact: string }>,
): string {
  return results
    .filter((r) => r.artifact)
    .map((r) => `## ${r.repoName}\n\n${r.artifact}`)
    .join('\n\n---\n\n');
}

export interface PerRepoStageStepOptions {
  id?: string;
  runner: AgentRunner;
  project: string;
  stageName: string;
  persona: string;
  model: string;
  maxOutputTokens?: number;
  buildProjectPrompt: (repoName: string) => string;
  buildStagePrompt: (repoName: string, prevArtifact: string) => string;
  onAgentSpawned?: (repoName: string, agentId: string) => void;
  writeRepoArtifact?: (repoName: string, artifact: string) => void;
  allowedTools?: string[];
}

export function createPerRepoStageStep(
  opts: PerRepoStageStepOptions,
): Step<string, RunPerRepoStageResult> {
  const id = opts.id ?? `per-repo-stage:${opts.stageName}`;

  return {
    id,
    name: `Per-repo stage (${opts.stageName})`,
    parallelism: 'per-repo',
    async run(ctx: StepContext<string>): Promise<RunPerRepoStageResult> {
      const repoName = ctx.repoName;
      if (!repoName) {
        throw new Error(
          `[${id}] requires ctx.repoName — did the walker forget to fan out?`,
        );
      }
      const repoPath = ctx.repoPaths?.[repoName];
      if (!repoPath) {
        throw new Error(`[${id}] no repoPath registered for "${repoName}"`);
      }

      const result = await runPerRepoStageForRepo({
        runner: opts.runner,
        project: opts.project,
        stageName: opts.stageName,
        persona: opts.persona,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        repoName,
        repoPath,
        projectPrompt: opts.buildProjectPrompt(repoName),
        prompt: opts.buildStagePrompt(repoName, ctx.input),
        allowedTools: opts.allowedTools,
      });

      if (result.agentId) {
        opts.onAgentSpawned?.(repoName, result.agentId);
      }
      opts.writeRepoArtifact?.(repoName, result.artifact);
      return result;
    },
  };
}
