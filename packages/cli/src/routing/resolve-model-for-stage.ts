/**
 * Composes stage-policy.yaml + ~/.anvil/models.yaml + agent-core's
 * resolver into a single function call sites can use:
 *
 *   const chain = resolveModelForStage('build');
 *   // → { primary, fallbacks: RouteFallback[] }
 *
 * Caches the loaded policy + registry on first call so repeated resolves
 * within a process don't re-read yaml. Pass `opts.refresh = true` to
 * force a re-read (e.g., after the user edits models.yaml at runtime).
 */

import {
  loadModelRegistry,
  resolveModel,
  ModelResolutionError,
  type ModelRegistry,
  type ResolvedChain,
} from '@anvil/agent-core';
import { loadStagePolicy, type StagePolicyMap } from './load-stage-policy.js';

export class UnknownStageError extends Error {
  constructor(public readonly stageName: string, public readonly known: string[]) {
    super(
      `unknown stage "${stageName}"; known stages: [${known.join(', ')}]. ` +
      `Add it to packages/cli/src/routing/stage-policy.yaml or use a known id.`,
    );
    this.name = 'UnknownStageError';
  }
}

export interface ResolveModelForStageOptions {
  workspaceRoot?: string;
  /** Override / supplement process.env. */
  env?: NodeJS.ProcessEnv;
  /** Force re-read of yaml files even if cached. */
  refresh?: boolean;
  /**
   * Optional minimum context window the call needs. Forwarded to
   * agent-core's resolver as `minContextTokens`.
   */
  minContextTokens?: number;
}

interface CachedState {
  policy: StagePolicyMap;
  registry: ModelRegistry;
}

let cached: CachedState | null = null;

function ensureLoaded(opts: ResolveModelForStageOptions): CachedState {
  if (cached && !opts.refresh) return cached;
  const policy = loadStagePolicy({ workspaceRoot: opts.workspaceRoot, env: opts.env });
  const registry = loadModelRegistry({ workspaceRoot: opts.workspaceRoot, env: opts.env });
  cached = { policy, registry };
  return cached;
}

export function resolveModelForStage(
  stageName: string,
  opts: ResolveModelForStageOptions = {},
): ResolvedChain {
  const { policy, registry } = ensureLoaded(opts);
  const stage = policy.stages[stageName];
  if (!stage) {
    throw new UnknownStageError(stageName, Object.keys(policy.stages));
  }
  return resolveModel(
    {
      capability: stage.capability,
      complexity: stage.complexity,
      prefer: stage.prefer,
      minContextTokens: opts.minContextTokens,
    },
    registry,
  );
}

/** Test seam — clears the cached policy + registry. */
export function _resetStageRoutingCache(): void {
  cached = null;
}

// Re-export so callers don't need a second import for the error type.
export { ModelResolutionError } from '@anvil/agent-core';
