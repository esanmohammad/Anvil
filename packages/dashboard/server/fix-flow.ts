/**
 * `fix-flow` — multi-stage Fix orchestrator.
 *
 * Replaces the single-agent `run-fix` quick action with a `fix → validate
 * → fix-loop` pipeline. Reuses the step factories under
 * `steps/fix.step.ts`, `steps/validate.step.ts`, and the existing
 * `steps/fix-loop.step.ts`.
 *
 * Behaviour:
 *   1. Spawn fix agent against the bug description (per-repo or single).
 *   2. Run validate. If it passes, the flow completes.
 *   3. If validate fails, run fix-loop with the validate artifact, then
 *      re-validate. Repeat up to `maxAttempts` (default from
 *      `walker.max_attempts` in models.yaml or 3).
 *   4. If validate still fails after the cap, throw — caller marks the
 *      run failed and reports the attempt count.
 *
 * Stage broadcasts fire via the caller-supplied `onStage` callback so the
 * dashboard's Active Runs list can render a per-stage strip
 * (`fix → validate → fix-loop` with status dots).
 */

// Note: dashboard's fix.step.ts shim accepts the legacy {agentManager,...}
// shape so fix-flow.ts can keep its current call shape unchanged.
import { runFix, type RunFixResult } from './steps/fix.step.js';
import { runValidate, type RunValidateResult } from './steps/validate.step.js';
import { runFixLoop } from './steps/fix-loop.step.js';
import type { AgentManager } from '@esankhan3/anvil-agent-core';

export type FixFlowStageName = 'fix' | 'validate' | 'fix-loop';
export type FixFlowStageStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface FixFlowStageEvent {
  name: FixFlowStageName;
  status: FixFlowStageStatus;
  attempt?: number;
  error?: string;
  cost?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface RunFixFlowOptions {
  agentManager: AgentManager;
  project: string;
  description: string;
  /** Resolved model id used for every stage. Resolver picks once and we
   *  keep it fixed through the loop. */
  model: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  buildProjectPrompt: () => string;
  buildRepoProjectPrompt: (repoName: string) => string;
  isCancelled: () => boolean;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  maxOutputTokens?: number;
  /** Per-stage allow-list lookup (fix vs validate vs fix-loop). */
  allowedToolsForStage: (stage: 'fix' | 'validate' | 'fix-loop') => string[] | undefined;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Fired once per stage transition. */
  onStage?: (event: FixFlowStageEvent) => void;
  /** Cap on validate-fix retries. Defaults to 3. */
  maxAttempts?: number;
  /** Spawn-id sink — surfaces every spawned agent for activity-log routing. */
  onSpawn?: (stage: FixFlowStageName, repoName: string | null, agentId: string) => void;
}

export interface RunFixFlowResult {
  fix: RunFixResult;
  validate: RunValidateResult;
  attempts: number;
  resolved: boolean;
  totalCost: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runFixFlow(opts: RunFixFlowOptions): Promise<RunFixFlowResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const startedAt = () => new Date().toISOString();
  let totalCost = 0;

  // ── Stage 1: fix ────────────────────────────────────────────────────
  opts.onStage?.({ name: 'fix', status: 'running', startedAt: startedAt() });
  let fixResult: RunFixResult;
  try {
    fixResult = await runFix({
      agentManager: opts.agentManager,
      project: opts.project,
      description: opts.description,
      model: opts.model,
      workspaceDir: opts.workspaceDir,
      repoNames: opts.repoNames,
      repoPaths: opts.repoPaths,
      buildProjectPrompt: opts.buildProjectPrompt,
      buildRepoProjectPrompt: opts.buildRepoProjectPrompt,
      isCancelled: opts.isCancelled,
      onTruncation: opts.onTruncation,
      maxOutputTokens: opts.maxOutputTokens,
      allowedTools: opts.allowedToolsForStage('fix'),
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
      onSpawn: (repo, id) => opts.onSpawn?.('fix', repo, id),
    });
    totalCost += fixResult.cost;
    opts.onStage?.({
      name: 'fix', status: 'completed', completedAt: startedAt(), cost: fixResult.cost,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onStage?.({ name: 'fix', status: 'failed', error: msg, completedAt: startedAt() });
    throw err;
  }

  // ── Stage 2: validate ──────────────────────────────────────────────
  let validateResult: RunValidateResult;
  try {
    opts.onStage?.({ name: 'validate', status: 'running', startedAt: startedAt() });
    validateResult = await runValidate({
      agentManager: opts.agentManager,
      project: opts.project,
      model: opts.model,
      workspaceDir: opts.workspaceDir,
      repoNames: opts.repoNames,
      repoPaths: opts.repoPaths,
      buildProjectPrompt: opts.buildProjectPrompt,
      buildRepoProjectPrompt: opts.buildRepoProjectPrompt,
      isCancelled: opts.isCancelled,
      onTruncation: opts.onTruncation,
      maxOutputTokens: opts.maxOutputTokens,
      allowedTools: opts.allowedToolsForStage('validate'),
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
      onSpawn: (repo, id) => opts.onSpawn?.('validate', repo, id),
    });
    totalCost += validateResult.cost;
    opts.onStage?.({
      name: 'validate',
      status: validateResult.failed ? 'failed' : 'completed',
      completedAt: startedAt(),
      cost: validateResult.cost,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onStage?.({ name: 'validate', status: 'failed', error: msg, completedAt: startedAt() });
    throw err;
  }

  if (!validateResult.failed) {
    return { fix: fixResult, validate: validateResult, attempts: 0, resolved: true, totalCost };
  }

  // ── Stage 3: fix-loop (only when validate failed) ─────────────────
  const priorByRepo = new Map(fixResult.agentIds);
  let priorSingleId = fixResult.singleAgentId;
  let attempt = 0;

  while (attempt < maxAttempts) {
    if (opts.isCancelled()) throw new Error('Pipeline cancelled');
    attempt += 1;
    opts.onStage?.({
      name: 'fix-loop', status: 'running', attempt, startedAt: startedAt(),
    });

    let attemptCost = 0;
    try {
      const loopResult = await runFixLoop({
        agentManager: opts.agentManager,
        project: opts.project,
        model: opts.model,
        workspaceDir: opts.workspaceDir,
        repoNames: opts.repoNames,
        repoPaths: opts.repoPaths,
        validateArtifact: validateResult.artifact,
        attempt,
        priorByRepo,
        priorSingleId,
        buildProjectPromptForBuildStage: opts.buildProjectPrompt,
        buildRepoProjectPromptForBuildStage: opts.buildRepoProjectPrompt,
        isCancelled: opts.isCancelled,
        onTruncation: opts.onTruncation,
        maxOutputTokens: opts.maxOutputTokens,
        allowedTools: opts.allowedToolsForStage('fix-loop'),
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
      });
      priorSingleId = loopResult.newSingleId;
      attemptCost += loopResult.cost;
      totalCost += loopResult.cost;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStage?.({
        name: 'fix-loop', status: 'failed', attempt, error: msg, completedAt: startedAt(),
      });
      throw err;
    }

    // Re-validate after every fix-loop attempt.
    try {
      const revalidateResult = await runValidate({
        agentManager: opts.agentManager,
        project: opts.project,
        model: opts.model,
        workspaceDir: opts.workspaceDir,
        repoNames: opts.repoNames,
        repoPaths: opts.repoPaths,
        buildProjectPrompt: opts.buildProjectPrompt,
        buildRepoProjectPrompt: opts.buildRepoProjectPrompt,
        isCancelled: opts.isCancelled,
        onTruncation: opts.onTruncation,
        maxOutputTokens: opts.maxOutputTokens,
        allowedTools: opts.allowedToolsForStage('validate'),
        pollIntervalMs: opts.pollIntervalMs,
        sleep: opts.sleep,
        onSpawn: (repo, id) => opts.onSpawn?.('validate', repo, id),
      });
      validateResult = revalidateResult;
      attemptCost += revalidateResult.cost;
      totalCost += revalidateResult.cost;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.onStage?.({
        name: 'fix-loop', status: 'failed', attempt, error: `revalidate failed: ${msg}`,
        completedAt: startedAt(),
      });
      throw err;
    }

    if (!validateResult.failed) {
      opts.onStage?.({
        name: 'fix-loop', status: 'completed', attempt, completedAt: startedAt(),
        cost: attemptCost,
      });
      return { fix: fixResult, validate: validateResult, attempts: attempt, resolved: true, totalCost };
    }

    opts.onStage?.({
      name: 'fix-loop', status: 'failed', attempt,
      error: `validate still failing after attempt ${attempt}`,
      completedAt: startedAt(), cost: attemptCost,
    });
  }

  // Exhausted the cap.
  throw new Error(`fix-loop exhausted after ${maxAttempts} attempts; validation still failing`);
}
