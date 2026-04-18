/**
 * Pipeline Learner — auto-learns memories from pipeline outcomes.
 *
 * Listens for pipeline-complete and pipeline-fail events, then creates
 * structured memory entries in the dashboard MemoryStore. These memories
 * are injected into future agent prompts so the system improves over time.
 *
 * Memory kinds:
 *   - success: what worked (feature completed, approach used)
 *   - fix-pattern: how validation failures were resolved
 *   - approach: what was tried when stages failed (for future avoidance)
 */

import type { MemoryStore } from './memory-store.js';

export interface PipelineRunState {
  runId: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: string;
  currentStage: number;
  stages: Array<{
    name: string;
    label: string;
    status: string;
    cost: number;
    error: string | null;
    artifact?: string;
    repos: Array<{
      repoName: string;
      status: string;
      cost: number;
      error: string | null;
    }>;
  }>;
  totalCost: number;
  model: string;
  repoNames: string[];
}

/**
 * Record a successful pipeline completion as a memory entry.
 * Captures which stages ran, total cost, and repos involved.
 */
export function learnFromSuccess(
  memoryStore: MemoryStore,
  state: PipelineRunState,
): void {
  const completedStages = state.stages
    .filter(s => s.status === 'completed')
    .map(s => s.name);

  const repoList = state.repoNames.length > 0
    ? state.repoNames.join(', ')
    : 'single-repo';

  const entry = [
    `[success] Feature: "${state.feature}"`,
    `Repos: ${repoList}`,
    `Stages completed: ${completedStages.join(' → ')}`,
    `Total cost: $${state.totalCost.toFixed(2)}`,
    `Model: ${state.model}`,
  ].join('\n');

  memoryStore.add(state.project, 'memory', entry);
}

/**
 * Record a pipeline failure as a memory entry.
 * Captures which stage failed, the error, and what was tried.
 */
export function learnFromFailure(
  memoryStore: MemoryStore,
  state: PipelineRunState,
): void {
  const failedStage = state.stages.find(s => s.status === 'failed');
  if (!failedStage) return;

  // Collect repo-level failures if any
  const repoErrors = failedStage.repos
    .filter(r => r.status === 'failed' && r.error)
    .map(r => `  - ${r.repoName}: ${r.error!.slice(0, 200)}`);

  const entry = [
    `[failure] Feature: "${state.feature}"`,
    `Failed at stage: ${failedStage.name}`,
    failedStage.error ? `Error: ${failedStage.error.slice(0, 300)}` : null,
    repoErrors.length > 0 ? `Repo errors:\n${repoErrors.join('\n')}` : null,
    `Model: ${state.model}`,
  ].filter(Boolean).join('\n');

  memoryStore.add(state.project, 'memory', entry);
}

/**
 * Record fix patterns when the validate stage had failures that were resolved.
 * Captures what broke and how the fix loop resolved it.
 */
export function learnFromFixLoop(
  memoryStore: MemoryStore,
  state: PipelineRunState,
): void {
  const validateStage = state.stages.find(s => s.name === 'validate');
  if (!validateStage || validateStage.status !== 'completed') return;

  // Check if there were fix stages that ran (indicates validation had failures)
  const fixStages = state.stages.filter(s =>
    s.name.startsWith('fix-') && s.status === 'completed'
  );
  if (fixStages.length === 0) return;

  const entry = [
    `[fix-pattern] Feature: "${state.feature}"`,
    `Validation required ${fixStages.length} fix iteration(s) before passing.`,
    `Repos: ${state.repoNames.join(', ') || 'single-repo'}`,
  ].join('\n');

  memoryStore.add(state.project, 'memory', entry);
}

/**
 * Main entry point — call after any pipeline completes or fails.
 */
export function autoLearn(
  memoryStore: MemoryStore,
  state: PipelineRunState,
): void {
  try {
    if (state.status === 'completed') {
      learnFromSuccess(memoryStore, state);
      learnFromFixLoop(memoryStore, state);
    } else if (state.status === 'failed') {
      learnFromFailure(memoryStore, state);
    }
  } catch {
    // Never let learning failures break the pipeline
  }
}
