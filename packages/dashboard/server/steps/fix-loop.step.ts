/**
 * Phase H8 — `fix-loop.step` was promoted into core-pipeline. The
 * canonical version requires `AgentSession`. This file is a back-compat
 * adapter — accepts the legacy `{agentManager, ...}` shape and
 * constructs an `AgentManagerSession` internally before delegating to
 * canonical `runFixLoop`.
 *
 * @deprecated Direct consumers should import canonical from
 *   `@esankhan3/anvil-core-pipeline` and pass an `AgentSession`.
 */

import type {
  AgentSession,
  Step,
  StepContext,
  RunFixLoopResult,
} from '@esankhan3/anvil-core-pipeline';
import {
  runFixLoop as runFixLoopCanonical,
  hasValidationFailures,
  extractRepoSection,
} from '@esankhan3/anvil-core-pipeline';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import { AgentManagerSession } from '../runners/agent-manager-session.js';

export {
  hasValidationFailures,
  extractRepoSection,
};
export type { RunFixLoopResult };

/**
 * Options shape — accepts a per-repo `sessionForRepo` resolver (the
 * canonical contract), a single `agentSession` (wrapped for every key), or
 * a legacy `agentManager` (a thin session is built + reused for all keys).
 */
export interface RunFixLoopOptions {
  sessionForRepo?: (repoName: string | null) => AgentSession;
  agentSession?: AgentSession;
  agentManager?: AgentManager;
  project: string;
  model?: string;
  maxOutputTokens?: number;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  validateArtifact: string;
  attempt: number;
  priorByRepo: Map<string, string>;
  priorSingleId: string | null;
  buildProjectPromptForBuildStage: () => string;
  buildRepoProjectPromptForBuildStage: (repoName: string) => string;
  isCancelled: () => boolean;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  allowedTools?: string[];
  /** Enclosing stage label for session turn-wiring + spawn (e.g. 'validate'). */
  sessionStage?: string;
  /** Stage key for burn-fallback model resolution (e.g. 'fix-loop'). */
  fallbackStage?: string;
}

export async function runFixLoop(opts: RunFixLoopOptions): Promise<RunFixLoopResult> {
  // Prefer the per-repo resolver; else fall back to ONE session reused for
  // every repo (legacy `agentSession`/`agentManager` callers), built once.
  let legacySingle: AgentSession | undefined;
  const sessionForRepo: (repoName: string | null) => AgentSession =
    opts.sessionForRepo
    ?? (() => (legacySingle ??= opts.agentSession ?? buildSession(opts)));
  return runFixLoopCanonical({
    sessionForRepo,
    project: opts.project,
    model: opts.model,
    maxOutputTokens: opts.maxOutputTokens,
    workspaceDir: opts.workspaceDir,
    repoNames: opts.repoNames,
    repoPaths: opts.repoPaths,
    validateArtifact: opts.validateArtifact,
    attempt: opts.attempt,
    priorByRepo: opts.priorByRepo,
    priorSingleId: opts.priorSingleId,
    buildProjectPromptForBuildStage: opts.buildProjectPromptForBuildStage,
    buildRepoProjectPromptForBuildStage: opts.buildRepoProjectPromptForBuildStage,
    isCancelled: opts.isCancelled,
    allowedTools: opts.allowedTools,
    sessionStage: opts.sessionStage,
    fallbackStage: opts.fallbackStage,
  });
}

function buildSession(opts: RunFixLoopOptions): AgentSession {
  if (!opts.agentManager) {
    throw new Error('runFixLoop requires either agentSession or agentManager');
  }
  return new AgentManagerSession({
    agentManager: opts.agentManager,
    project: opts.project,
    workspaceDir: opts.workspaceDir,
    isCancelled: opts.isCancelled,
    resolveModel: () => opts.model ?? '',
    onTruncation: opts.onTruncation,
  });
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
