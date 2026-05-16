/**
 * Phase H3 — `fix.step` was promoted into
 * `core-pipeline/src/steps/fix.step.ts` with a new signature accepting
 * an `AgentRunner`.
 *
 * This file is a back-compat adapter — keeps the legacy
 * `{agentManager, isCancelled, onSpawn, onTruncation, ...}` opts
 * shape so fix-flow.ts compiles unchanged. Internally wraps into an
 * `AgentManagerRunner` and dispatches to the canonical `runFix`.
 *
 * @deprecated Direct consumers should import from
 *   `@esankhan3/anvil-core-pipeline` and pass an `AgentRunner`.
 */

import type { AgentManager } from '@esankhan3/anvil-agent-core';
import {
  runFix as runFixCanonical,
  type RunFixResult,
} from '@esankhan3/anvil-core-pipeline';
import { AgentManagerRunner } from '../runners/agent-manager-runner.js';

export type { RunFixResult };

export interface RunFixOptions {
  agentManager: AgentManager;
  project: string;
  description: string;
  model: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  buildProjectPrompt: () => string;
  buildRepoProjectPrompt: (repoName: string) => string;
  isCancelled: () => boolean;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  maxOutputTokens?: number;
  allowedTools?: string[];
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onSpawn?: (repoName: string | null, agentId: string) => void;
}

export async function runFix(opts: RunFixOptions): Promise<RunFixResult> {
  const burnedModels = new Set<string>();
  const runner = new AgentManagerRunner({
    agentManager: opts.agentManager,
    project: opts.project,
    workspaceDir: opts.workspaceDir,
    isCancelled: opts.isCancelled,
    resolveModel: () => opts.model,
    burnedModels,
    maxAttempts: 1,
    onSpawn: (agentId, req) => opts.onSpawn?.(req.repoName ?? null, agentId),
    onTruncation: opts.onTruncation,
  });

  return runFixCanonical({
    runner,
    project: opts.project,
    description: opts.description,
    model: opts.model,
    workspaceDir: opts.workspaceDir,
    repoNames: opts.repoNames,
    repoPaths: opts.repoPaths,
    buildProjectPrompt: opts.buildProjectPrompt,
    buildRepoProjectPrompt: opts.buildRepoProjectPrompt,
    maxOutputTokens: opts.maxOutputTokens,
    allowedTools: opts.allowedTools,
  });
}
