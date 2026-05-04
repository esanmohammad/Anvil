/**
 * `fix-loop` — Phase 4f.5 of the dashboard consolidation.
 *
 * Lifts the validation-failure → engineer-fix loop that
 * `pipeline-runner.ts:runFixLoop()` implements, plus the two pure
 * helpers it depends on (`hasValidationFailures`, `extractRepoSection`).
 *
 * Behavior parity with the legacy:
 *   - Single-repo path when `repoNames.length === 0` (uses workspaceDir
 *     as cwd) — spawns one fixer agent.
 *   - Per-repo path otherwise — extracts each repo's section out of the
 *     combined VALIDATE.md artifact, skips repos whose section has no
 *     failure markers, fans the remaining repos out via Promise.all.
 *   - Cross-attempt session resume (P9): on `attempt > 1`, if a prior
 *     agent id exists for the repo (or single path), call
 *     `agentManager.sendInput(priorId, followUp)` instead of spawning a
 *     fresh agent. The map is mutated in place so the next attempt
 *     finds the latest id.
 *   - Disallowed tools = `['Agent']` (engineer + tester rule).
 */

import { spawnAndWait, waitForAgent } from './agent-spawner.js';
import { disallowedToolsForPersona } from './per-repo-stage.step.js';
import type { AgentManager } from '@anvil/agent-core';
import type { Step, StepContext } from '@anvil/core-pipeline';

/**
 * Pure helper: detect validation failures in an artifact. Lifted
 * verbatim from `pipeline-runner.ts:hasValidationFailures()` so the
 * regex set is unchanged.
 */
export function hasValidationFailures(artifact: string): boolean {
  if (!artifact) return false;

  // Explicit markers always win.
  if (/VERDICT:\s*FAIL/i.test(artifact)) return true;
  if (/\bUNRESOLVED\b/i.test(artifact)) return true;

  for (const rawLine of artifact.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\bPASS\b/.test(line) && !/\bFAIL\b/.test(line)) continue;
    if (/\b(?:build|lint|linting|typecheck|type[- ]?check|tests?)\s+(?:failed|failing|errored|broken|has\s+errors?|exits?\s+non-?zero)\b/i.test(line)) return true;
    if (/(?:^|\s)(?:✗|✖|❌|FAILED:|FAIL:)/.test(line)) return true;
    if (/\b[1-9]\d*\s+(?:failed|failing)\b/i.test(line)) return true;
  }
  return false;
}

/**
 * Pure helper: extract the section of a combined VALIDATE.md artifact
 * that belongs to a specific repo. Lifted verbatim from
 * `pipeline-runner.ts:extractRepoSection()`.
 */
export function extractRepoSection(artifact: string, repoName: string): string {
  const regex = new RegExp(`## ${repoName}[\\s\\S]*?(?=## \\w|$)`, 'i');
  const match = artifact.match(regex);
  if (match) return match[0];
  if (artifact.includes(repoName)) return artifact;
  return '';
}

export interface RunFixLoopOptions {
  agentManager: AgentManager;
  /** Project slug — forwarded to the spawn config. */
  project: string;
  /** Resolved model id for the validate stage (the legacy resolves it then). */
  model: string;
  /** Optional output-token ceiling — legacy passes `maxOutputTokensForStage('build')`. */
  maxOutputTokens?: number;
  /** Workspace root — used as cwd for the single-repo path. */
  workspaceDir: string;
  /** Repo names; empty array triggers the single-repo path. */
  repoNames: string[];
  /** Map of repoName → absolute path. */
  repoPaths: Record<string, string>;
  /** Combined VALIDATE.md artifact from the prior validate stage. */
  validateArtifact: string;
  /** Attempt count (1 for first fix, ≥2 to resume the prior session). */
  attempt: number;
  /**
   * Per-repo prior-agent map. Mutated in place — callers retain the same
   * Map across attempts so resume-via-sendInput finds the right session.
   */
  priorByRepo: Map<string, string>;
  /**
   * Single-mode prior agent id. Returned alongside the result so the
   * caller can store it back for the next attempt.
   */
  priorSingleId: string | null;
  /** Builds the project (system) prompt for the build stage (single-repo path). */
  buildProjectPromptForBuildStage: () => string;
  /** Builds the per-repo project prompt for the build stage. */
  buildRepoProjectPromptForBuildStage: (repoName: string) => string;
  /** Returns true when the run has been cancelled. */
  isCancelled: () => boolean;
  /** Called when the agent's stop_reason is `max_tokens`. */
  onTruncation?: (agentName: string, outputTokens: number) => void;
  /** Test seams. */
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Per-stage allow list. Fix-loop needs read+write+exec to apply
   *  mechanical fixes — without this, agentic non-Claude adapters fall
   *  back to read-only and the engineer agent can't actually edit code. */
  allowedTools?: string[];
}

export interface RunFixLoopResult {
  /** Combined fix-output across all repos (single-repo: that one agent's output). */
  artifact: string;
  /** Aggregate USD cost. */
  cost: number;
  /**
   * Updated single-mode agent id. Caller stores this so attempt+1 can
   * resume via sendInput. Unchanged on per-repo path.
   */
  newSingleId: string | null;
  /** Aggregate input tokens across all spawns / resumes in this attempt. */
  inputTokens: number;
  /** Aggregate output tokens across all spawns / resumes in this attempt. */
  outputTokens: number;
  /** Aggregate cache READ tokens. */
  cacheReadTokens: number;
  /** Aggregate cache WRITE tokens. */
  cacheWriteTokens: number;
}

/**
 * Run one fix-loop attempt. Mutates `priorByRepo` in place; returns the
 * single-mode agent id alongside the artifact + cost so the caller can
 * persist it for the next attempt.
 *
 * Per-repo failures are NOT swallowed here (unlike the per-task build
 * fanout) — a single repo's fix throwing rejects the whole attempt,
 * matching legacy behavior.
 */
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
    if (priorId && opts.attempt > 1 && opts.agentManager.getAgent(priorId)) {
      const followUp = `Validation still failing in "${repoName}" after your last fix (attempt ${opts.attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
      opts.agentManager.sendInput(priorId, followUp);
      return waitForAgent({
        agentId: priorId,
        agentManager: opts.agentManager,
        isCancelled: opts.isCancelled,
        onTruncation: opts.onTruncation,
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
      });
    }

    const prompt = `The validation stage found issues in "${repoName}" that need to be fixed (attempt ${opts.attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures in this repo. Run the build and tests again to verify. Do NOT make git commits.`;
    const result = await spawnAndWait({
      agentManager: opts.agentManager,
      spec: {
        name: `fixer-${repoName}-${opts.attempt}`,
        persona: 'engineer',
        project: opts.project,
        stage: `fix-${opts.attempt}:${repoName}`,
        prompt,
        model: opts.model,
        cwd: repoPath,
        projectPrompt: opts.buildRepoProjectPromptForBuildStage(repoName),
        permissionMode: 'bypassPermissions',
        disallowedTools: disallowedToolsForPersona('engineer'),
        allowedTools: opts.allowedTools,
        maxOutputTokens: opts.maxOutputTokens,
      },
      isCancelled: opts.isCancelled,
      onSpawn: (agentId) => opts.priorByRepo.set(repoName, agentId),
      onTruncation: opts.onTruncation,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
    });
    return {
      artifact: result.artifact,
      cost: result.cost,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
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

  if (
    opts.priorSingleId
    && opts.attempt > 1
    && opts.agentManager.getAgent(opts.priorSingleId)
  ) {
    const followUp = `Validation still failing after your last fix (attempt ${opts.attempt}). Issues:\n\n${issuesBlock}\n\nFix the remaining errors and re-run tests.`;
    opts.agentManager.sendInput(opts.priorSingleId, followUp);
    const result = await waitForAgent({
      agentId: opts.priorSingleId,
      agentManager: opts.agentManager,
      isCancelled: opts.isCancelled,
      onTruncation: opts.onTruncation,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
    });
    return {
      artifact: result.artifact,
      cost: result.cost,
      newSingleId: opts.priorSingleId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    };
  }

  const prompt = `The validation stage found issues that need to be fixed (attempt ${opts.attempt}):\n\n${issuesBlock}\n\nFix ALL build errors, lint errors, and test failures. Run the build and tests again to verify. Do NOT make git commits.`;
  let newSingleId: string | null = null;
  const result = await spawnAndWait({
    agentManager: opts.agentManager,
    spec: {
      name: `fixer-${opts.project}-${opts.attempt}`,
      persona: 'engineer',
      project: opts.project,
      stage: `fix-${opts.attempt}`,
      prompt,
      model: opts.model,
      cwd: opts.workspaceDir,
      projectPrompt: opts.buildProjectPromptForBuildStage(),
      permissionMode: 'bypassPermissions',
      disallowedTools: disallowedToolsForPersona('engineer'),
      maxOutputTokens: opts.maxOutputTokens,
    },
    isCancelled: opts.isCancelled,
    onSpawn: (agentId) => { newSingleId = agentId; },
    onTruncation: opts.onTruncation,
    pollIntervalMs: opts.pollIntervalMs,
    sleep: opts.sleep,
  });
  return {
    artifact: result.artifact,
    cost: result.cost,
    newSingleId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
  };
}

export interface FixLoopStepOptions
  extends Omit<RunFixLoopOptions, 'isCancelled' | 'validateArtifact' | 'attempt'> {
  /** Optional Step id override; defaults to `fix-loop`. */
  id?: string;
  /**
   * Reads the validate artifact + attempt count from the Step input.
   * Default expects `ctx.input` shaped as `{ validateArtifact, attempt }`.
   */
  readInput?: (ctx: StepContext<unknown>) => { validateArtifact: string; attempt: number };
  /**
   * Optional cancellation predicate — defaults to `ctx.signal.aborted`.
   */
  isCancelled?: (ctx: StepContext<unknown>) => boolean;
}

/**
 * Step factory for one fix-loop attempt. Phase 4f.7 wires registration
 * once `Pipeline.run()` becomes the orchestrator.
 *
 * Note: the legacy `runFixLoop` is invoked imperatively from within the
 * validate-loop iteration in pipeline-runner. The Step factory shape is
 * exposed for parity testing + future composition; today the production
 * caller goes through `runFixLoop()` directly.
 */
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
