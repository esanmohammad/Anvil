/**
 * `fix-loop` step factory — validation-failure → engineer-fix loop.
 *
 * Phase H8 — promoted from
 * `packages/dashboard/server/steps/fix-loop.step.ts` into
 * `core-pipeline/src/steps`. Refactored to require an `AgentSession`
 * (legacy direct AgentManager fallback dropped from the canonical
 * path). The dashboard's `AgentManagerSession` satisfies it.
 *
 * Behavior parity with the legacy:
 *   - Single-repo path when `repoNames.length === 0`.
 *   - Per-repo path otherwise — extracts each repo's section, skips
 *     repos with no failure markers, fans the rest out via Promise.all.
 *   - Cross-attempt session resume: on `attempt > 1`, if a prior
 *     agentId exists for the repo, sendInput() that session instead
 *     of starting a fresh one. Map mutated in place.
 *   - Disallowed tools handled by AgentSession's spawn defaults.
 */

import type { Step, StepContext } from '../types.js';
import type { AgentSession } from '../agent-session.js';
import {
  hasValidationFailures,
  extractRepoSection,
} from './validate.step.js';

export interface RunFixLoopOptions {
  /**
   * Multi-turn agent surface, resolved PER REPO (null = single-repo mode).
   * fix-loop fans out across repos in parallel AND resumes across attempts,
   * so each repo needs its OWN session: a burn-aware session carries that
   * repo's per-phase chain-fallback + a per-repo-scoped turn recorder
   * (cost/provenance) + cross-attempt resume. A caller with one session for
   * everything can return it for every key.
   */
  sessionForRepo: (repoName: string | null) => AgentSession;
  project: string;
  /** Resolved model id. */
  model?: string;
  maxOutputTokens?: number;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  /** Combined VALIDATE.md artifact from the prior validate stage. */
  validateArtifact: string;
  /** Attempt count (1 for first fix, ≥2 to resume the prior session). */
  attempt: number;
  /** Per-repo prior-agent map. Mutated in place. */
  priorByRepo: Map<string, string>;
  /** Single-mode prior agent id. */
  priorSingleId: string | null;
  buildProjectPromptForBuildStage: () => string;
  buildRepoProjectPromptForBuildStage: (repoName: string) => string;
  isCancelled: () => boolean;
  /**
   * Stage label for the spawn + (load-bearing) the burn-aware session's turn
   * wiring `eventStepId` (`${sessionStage}:session`). Must be the ENCLOSING
   * pipeline step ('validate') so its turn cost/provenance roll up under that
   * step's `step:completed` (the runner rolls up `validate` + `validate:session`).
   * Defaults to `fix-${attempt}` (legacy label; not rolled up).
   */
  sessionStage?: string;
  /**
   * Stage key for burn-fallback MODEL resolution (`routingStage` on the spawn
   * request). When `sessionStage` is the enclosing step ('validate'), this
   * keeps the post-burn chain on the 'fix-loop' policy ('tight retry loop —
   * never escalate to premium') instead of inheriting validate's chain.
   */
  fallbackStage?: string;
  /** Tools that the engineer agent must NOT call. */
  disallowedTools?: readonly string[];
  /** Per-stage allow list. */
  allowedTools?: string[];
}

export interface RunFixLoopResult {
  artifact: string;
  cost: number;
  newSingleId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const ENGINEER_DISALLOWED_TOOLS: readonly string[] = ['Agent'];

export async function runFixLoop(
  opts: RunFixLoopOptions,
): Promise<RunFixLoopResult> {
  const repos = opts.repoNames;

  if (repos.length === 0) {
    return runFixLoopSingle(opts);
  }

  const promises = repos.map(async (repoName) => {
    const repoPath = opts.repoPaths[repoName] ?? '';
    const repoSection = extractRepoSection(opts.validateArtifact, repoName);
    if (!repoSection || !hasValidationFailures(repoSection)) {
      return {
        artifact: '',
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
    }
    const issuesBlock = repoSection.slice(0, 4000);

    const priorId = opts.priorByRepo.get(repoName);
    const followUp = `Validation still failing in "${repoName}" after your last fix (attempt ${opts.attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
    const initialPrompt = `The validation stage found issues in "${repoName}" that need to be fixed (attempt ${opts.attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures in this repo. Run the build and tests again to verify. Do NOT make git commits.`;

    const session = opts.sessionForRepo(repoName);
    if (priorId && opts.attempt > 1) {
      const r = await session.sendInput(priorId, followUp);
      return {
        artifact: r.output,
        cost: r.costUsd ?? 0,
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        cacheReadTokens: r.cacheReadTokens ?? 0,
        cacheWriteTokens: r.cacheWriteTokens ?? 0,
      };
    }
    const r = await session.start({
      persona: 'engineer',
      projectPrompt: opts.buildRepoProjectPromptForBuildStage(repoName),
      userPrompt: initialPrompt,
      workingDir: repoPath,
      stage: opts.sessionStage ?? `fix-${opts.attempt}`,
      routingStage: opts.fallbackStage,
      model: opts.model,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools ?? ENGINEER_DISALLOWED_TOOLS,
      maxOutputTokens: opts.maxOutputTokens,
      repoName,
    });
    opts.priorByRepo.set(repoName, r.sessionId);
    return {
      artifact: r.output,
      cost: r.costUsd ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
    };
  });

  const results = await Promise.all(promises);
  const combinedArtifact = results.map((r) => r.artifact).filter(Boolean).join('\n\n');
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
  return {
    artifact: combinedArtifact,
    cost: totalCost,
    newSingleId: opts.priorSingleId,
    inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
    cacheReadTokens: results.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWriteTokens: results.reduce((s, r) => s + r.cacheWriteTokens, 0),
  };
}

async function runFixLoopSingle(
  opts: RunFixLoopOptions,
): Promise<RunFixLoopResult> {
  const issuesBlock = opts.validateArtifact.slice(0, 6000);
  const followUp = `Validation still failing after your last fix (attempt ${opts.attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
  const initialPrompt = `The validation stage found issues that need to be fixed (attempt ${opts.attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures. Run the build and tests again to verify. Do NOT make git commits.`;

  const session = opts.sessionForRepo(null);
  if (opts.priorSingleId && opts.attempt > 1) {
    const r = await session.sendInput(opts.priorSingleId, followUp);
    return {
      artifact: r.output,
      cost: r.costUsd ?? 0,
      newSingleId: opts.priorSingleId,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
    };
  }
  const r = await session.start({
    persona: 'engineer',
    projectPrompt: opts.buildProjectPromptForBuildStage(),
    userPrompt: initialPrompt,
    workingDir: opts.workspaceDir,
    stage: opts.sessionStage ?? `fix-${opts.attempt}`,
    routingStage: opts.fallbackStage,
    model: opts.model,
    // Match the per-repo path: a non-Claude agentic model needs write/exec
    // tools to apply a fix; omitting this falls back to read-only.
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools ?? ENGINEER_DISALLOWED_TOOLS,
    maxOutputTokens: opts.maxOutputTokens,
  });
  return {
    artifact: r.output,
    cost: r.costUsd ?? 0,
    newSingleId: r.sessionId,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
  };
}

export interface FixLoopStepOptions
  extends Omit<RunFixLoopOptions, 'isCancelled' | 'validateArtifact' | 'attempt'> {
  id?: string;
  readInput?: (ctx: StepContext<unknown>) => { validateArtifact: string; attempt: number };
  isCancelled?: (ctx: StepContext<unknown>) => boolean;
}

export function createFixLoopStep(
  opts: FixLoopStepOptions,
): Step<unknown, RunFixLoopResult> {
  const id = opts.id ?? 'fix-loop';
  return {
    id,
    name: 'Fix loop attempt',
    parallelism: 'serial',
    async run(ctx: StepContext<unknown>): Promise<RunFixLoopResult> {
      const { validateArtifact, attempt } = opts.readInput
        ? opts.readInput(ctx)
        : (ctx.input as { validateArtifact: string; attempt: number });
      const isCancelled = opts.isCancelled
        ? () => opts.isCancelled!(ctx)
        : () => ctx.signal.aborted;
      return runFixLoop({
        ...opts,
        validateArtifact,
        attempt,
        isCancelled,
      });
    },
  };
}
