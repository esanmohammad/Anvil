/**
 * Generic per-repo stage runner. Used by repo-requirements, specs, and
 * tasks — three structurally identical stages that fan out across repos,
 * spawn one analyst/architect/lead agent per repo in parallel, write
 * `<NAME>.md` per repo, and combine the outputs.
 *
 * Built around `AgentRunner` so cli and dashboard share the same shape.
 * After R7 lands and the dashboard migrates to `Pipeline.run()`, this
 * function is the body of the `repo-requirements` / `specs` / `tasks`
 * Step factories.
 *
 * Empty-artifact defense (Step 3 from earlier sessions) is baked in —
 * any repo that returns an artifact below `minArtifactLength` chars
 * throws a retryable upstream error, letting the router's agentic chain
 * walk (`LlmRouter.runAgent`) try the next model instead of writing a
 * 0-byte file.
 */

import type { AgentRunner } from '../agent-runner.js';
import type { StageContext, StageOutput, StageTokens } from './types.js';
import { emptyStageTokens } from './types.js';

export interface PerRepoStageOptions {
  /** Stage name — matches STAGES registry (repo-requirements, specs, tasks). */
  stageName: string;
  /** Persona running the stage (analyst, architect, lead). */
  persona: string;
  /** Build the user prompt for one repo. Receives prevArtifact (the prior
   *  stage's combined output) so per-repo prompts can reference it. */
  buildPrompt: (repoName: string, prevArtifact: string) => string;
  /** Build the system / project prompt for one repo. */
  buildProjectPrompt: (repoName: string) => string;
  /** Combined artifact from the prior stage (used by buildPrompt). */
  prevArtifact: string;
  /** Optional — minimum chars an artifact must have to be considered non-empty. */
  minArtifactLength?: number;
  /** Optional — tool whitelist forwarded to the agent. */
  allowedTools?: readonly string[];
  /** Optional — tool deny-list. */
  disallowedTools?: readonly string[];
  /** Optional — output token cap honored where the adapter exposes a flag. */
  maxOutputTokens?: number;
  /** Optional — fired the moment each repo's run starts. Lets the UI surface a "spawned" line. */
  onRepoStart?: (repoName: string) => void;
  /** Optional — fired when each repo's artifact lands. Lets the caller persist + telemetry. */
  onRepoComplete?: (repoName: string, artifact: string, tokens: StageTokens, costUsd: number) => void;
  /** Optional — fired when a repo fails. Caller decides whether to surface a partial-success run. */
  onRepoFail?: (repoName: string, error: unknown) => void;
}

/**
 * Run a per-repo stage. All repos run in parallel via `Promise.all`.
 * Per-repo atomicity: any repo failure (empty artifact or thrown error)
 * fails the whole stage so the next stage doesn't run on a partial
 * codebase. Caller decides via `onRepoFail` whether to surface the
 * partial-success view.
 */
export async function runPerRepoStage(
  ctx: StageContext,
  opts: PerRepoStageOptions,
): Promise<StageOutput> {
  const minLen = opts.minArtifactLength ?? 50;
  const repoArtifacts: Record<string, string> = {};
  const failures = new Map<string, unknown>();

  let totalCost = 0;
  const totals = emptyStageTokens();

  await Promise.all(
    ctx.repoNames.map(async (repoName) => {
      try {
        opts.onRepoStart?.(repoName);
        const result = await ctx.agentRunner.run({
          persona: opts.persona,
          projectPrompt: opts.buildProjectPrompt(repoName),
          userPrompt: opts.buildPrompt(repoName, opts.prevArtifact),
          workingDir: ctx.repoPaths[repoName] ?? ctx.workspaceDir,
          stage: opts.stageName,
          allowedTools: opts.allowedTools,
          disallowedTools: opts.disallowedTools,
          maxOutputTokens: opts.maxOutputTokens,
          repoName,
        });

        const artifact = result.output ?? '';
        if (artifact.trim().length < minLen) {
          // Empty-artifact defense — surface as retryable so chain-fallback walks.
          const err = new Error(
            `[per-repo:${opts.stageName}/${repoName}] artifact too short (${artifact.length} chars)`,
          );
          (err as Error & { name: string; status: number; retryable: boolean }).name = 'UpstreamError';
          (err as Error & { name: string; status: number; retryable: boolean }).status = 503;
          (err as Error & { name: string; status: number; retryable: boolean }).retryable = true;
          throw err;
        }

        repoArtifacts[repoName] = artifact;
        const tokens: StageTokens = {
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
          cacheReadTokens: result.cacheReadTokens ?? 0,
          cacheWriteTokens: result.cacheWriteTokens ?? 0,
        };
        const cost = result.costUsd ?? 0;
        totalCost += cost;
        totals.inputTokens += tokens.inputTokens;
        totals.outputTokens += tokens.outputTokens;
        totals.cacheReadTokens += tokens.cacheReadTokens;
        totals.cacheWriteTokens += tokens.cacheWriteTokens;
        opts.onRepoComplete?.(repoName, artifact, tokens, cost);
      } catch (err) {
        failures.set(repoName, err);
        opts.onRepoFail?.(repoName, err);
      }
    }),
  );

  if (failures.size > 0) {
    const which = [...failures.keys()].join(', ');
    throw new Error(
      `Per-repo stage "${opts.stageName}" failed on ${failures.size} of ${ctx.repoNames.length} repo(s): ${which}. ` +
      `Stage cannot advance — retry the run or rerun this stage after fixing the underlying error.`,
    );
  }

  // Combine artifacts in canonical "## <repo>\n\n<artifact>" form.
  const combined = ctx.repoNames
    .map((r) => `## ${r}\n\n${repoArtifacts[r]}`)
    .join('\n\n---\n\n');

  return {
    artifact: combined,
    repoArtifacts,
    costUsd: totalCost,
    tokens: totals,
    tokenEstimate: totals.inputTokens + totals.outputTokens,
  };
}
