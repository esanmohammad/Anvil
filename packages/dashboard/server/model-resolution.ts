/**
 * `model-resolution` — pure helpers for per-stage model picking,
 * tool-permission resolution, and provider-liveness prefetch.
 *
 * Extracted from `pipeline-runner.ts` so the runner stays focused on
 * orchestration. Each function takes a `ModelResolutionDeps` opts bag
 * and operates on caller-supplied state. The walker config is returned
 * from `prefetchProviderLiveness` rather than mutated through a ref —
 * the runner owns the field and re-assigns from the return value.
 */
import {
  resolveModelByTier,
  loadModelRegistry,
  DEFAULT_WALKER_CONFIG,
  type ModelRegistry,
  type ProviderName,
  type WalkerConfig,
} from '@esankhan3/anvil-agent-core';
import {
  resolveModelForStage as registryResolveStage,
  ModelResolutionError,
  UnknownStageError,
  allowedToolsForStage,
  permissionClassesForStage,
} from '@esankhan3/anvil-core-pipeline';
import { pickAliveModelFromChainSync, prefetchLiveness, isProviderAlive, setLivenessTtlMs } from './provider-liveness.js';
import type { ProjectLoader } from './project-loader.js';
import {
  LOCAL_TIER_STAGES,
  providerOfModelId,
  type PipelineConfig,
  type PipelineRunState,
} from './pipeline-runner-types.js';

export interface ModelResolutionDeps {
  config: PipelineConfig;
  projectLoader: ProjectLoader;
  state: PipelineRunState;
  runtimeBurnedModels: Set<string>;
  /** model id → reason burned (HTTP 429 / stage / etc). Optional for back-compat. */
  burnedModelReasons?: Map<string, string>;
  livenessFallbackNotified: Set<string>;
  emitProjectEvent: (payload: { source: string; message: string; level: 'info' | 'warn' }) => void;
  broadcast: () => void;
}

/**
 * Resolve which model to use for a given stage.
 * Priority: factory.yaml per-stage override → tier-based dynamic
 * routing → single model fallback. Records the resolution onto
 * `state.stages[i]` so the UI surfaces the routing decision live.
 */
export function resolveModelForStage(deps: ModelResolutionDeps, stageName: string): string {
  const picked = pickModelForStage(deps, stageName);
  recordResolvedStageState(deps, stageName, picked);
  return picked;
}

/**
 * Pure resolution chain — no state mutation. Extracted so the public
 * resolver can layer on the state-recording side effect for UI surfacing.
 */
export function pickModelForStage(deps: ModelResolutionDeps, stageName: string): string {
  // 1. factory.yaml per-stage override always wins.
  const yamlModels = deps.projectLoader.getConfig(deps.config.project)?.pipeline?.models;
  if (yamlModels?.[stageName]) return yamlModels[stageName];

  // 2. Registry-driven resolver — reads stage-policy.yaml +
  //    ~/.anvil/models.yaml and picks the cheapest model that meets
  //    the stage's capability/complexity bar.
  try {
    const resolved = registryResolveStage(stageName);
    const picked = pickAliveModelFromChainSync(
      resolved,
      providerOfModelId,
      deps.runtimeBurnedModels,
    );
    if (picked.fellBackFrom) {
      // Show the FULL chain walk + the actual burn reason for each
      // skipped model. The walker's `skipped[]` carries 'burned' vs
      // 'liveness-dead'; for burned models we also look up the
      // recorded reason ("HTTP 429 (clarify stage)" etc.) so the
      // user can see WHY at a glance instead of just THAT.
      const skipList = picked.skipped ?? [];
      const reasonFor = (s: { model: string; reason: string }): string => {
        if (s.reason !== 'burned') return s.reason;
        const recorded = deps.burnedModelReasons?.get(s.model);
        return recorded ? `burned: ${recorded}` : 'burned';
      };
      const skipDetail = skipList.length > 0
        ? skipList.map((s) => `${s.model} [${reasonFor(s)}]`).join(' → ')
        : `${picked.fellBackFrom} [unknown]`;
      console.warn(
        `[pipeline] ${stageName}: chain walked ${skipDetail} → ${picked.model}`,
      );
      const key = `${stageName}|${picked.fellBackFrom}->${picked.model}`;
      if (!deps.livenessFallbackNotified.has(key)) {
        deps.livenessFallbackNotified.add(key);
        deps.emitProjectEvent({
          source: 'routing',
          message: `${stageName}: walked ${skipDetail} → ${picked.model}`,
          level: 'warn',
        });
      }
    }
    return picked.model;
  } catch (err) {
    if (err instanceof UnknownStageError) {
      // Stage not declared in policy yaml — drop to legacy paths.
    } else if (err instanceof ModelResolutionError) {
      console.warn(`[pipeline] resolver: ${err.message}; falling back to legacy chain`);
    } else {
      console.warn(`[pipeline] resolver crashed:`, err);
    }
  }

  // 3. ANVIL_LOCAL_MODEL legacy override.
  const localModel = process.env.ANVIL_LOCAL_MODEL?.trim();
  if (localModel && LOCAL_TIER_STAGES.has(stageName)) {
    return localModel;
  }

  // 4. If no tier selected, use the single model from the UI dropdown.
  const tier = deps.config.modelTier;
  if (!tier) return deps.config.model;

  // 5. Tier-based legacy routing — last resort.
  return resolveModelByTier(tier, stageName, deps.config.model);
}

/**
 * Per-stage tool-permission set. Resolution: stage-policy default →
 * factory.yaml allow extends → factory.yaml deny strips. Empty result
 * falls back to read-only.
 */
export function allowedToolsForCurrentStage(deps: ModelResolutionDeps, stageName: string): string[] {
  const base = new Set(allowedToolsForStage(stageName));
  const overrides = deps.projectLoader
    .getConfig(deps.config.project)?.pipeline?.permissions?.[stageName];
  if (overrides?.allow_tools) for (const t of overrides.allow_tools) base.add(t);
  if (overrides?.deny_tools) for (const t of overrides.deny_tools) base.delete(t);
  if (base.size === 0) return ['read_file', 'grep', 'glob', 'list'];
  return [...base].sort();
}

/**
 * Stamp the per-stage state with the resolved model + permission set
 * the moment the resolver is consulted. Idempotent — same model on
 * the same stage doesn't re-broadcast.
 */
export function recordResolvedStageState(
  deps: ModelResolutionDeps,
  stageName: string,
  model: string,
): void {
  const stageIdx = deps.state.stages.findIndex((s) => s.name === stageName);
  if (stageIdx === -1) return;
  const stage = deps.state.stages[stageIdx];
  if (stage.resolvedModel && stage.resolvedModel === model) return;
  stage.resolvedModel = model;
  stage.permissionClasses = permissionClassesForStage(stageName);
  deps.broadcast();
}

/**
 * Pre-warm the provider-liveness cache + load the walker block from
 * `~/.anvil/models.yaml`. Returns the resolved walker config so the caller
 * can thread it through stage-fallback and retry loops.
 *
 * Two-tier probe (matches the "check the selected model, background the
 * rest" design):
 *   1. EAGER — probe ONLY the currently-selected model's provider and
 *      await it. Cloud providers (opencode / claude / gemini / …) are an
 *      instant env-var check; Ollama is a single 2s-capped network probe.
 *      This is the "does the model the user picked actually work" check.
 *   2. BACKGROUND — fire the full provider sweep fire-and-forget. The sync
 *      chain walker (`pickAliveModelFromChainSync`) treats a cold-cache
 *      provider as ALIVE, so the sweep never gates a stage; it just makes
 *      the cache fresher for later fallback decisions.
 *
 * There is deliberately NO blocking timeout race here. The previous 5s
 * `Promise.race` only delayed a background task (the hook that calls this
 * runs with `await: false`), yet logged a scary "liveness prefetch timed
 * out after 5s" line that read like a stall. Removing it: the eager probe
 * is naturally short-bounded by its own per-provider cap, and the sweep is
 * genuinely detached.
 */
export async function prefetchProviderLiveness(selectedModel?: string): Promise<WalkerConfig> {
  let walkerConfig: WalkerConfig = { ...DEFAULT_WALKER_CONFIG };
  let registry: ModelRegistry | null = null;
  try {
    registry = loadModelRegistry();
    walkerConfig = registry.walker;
    setLivenessTtlMs(walkerConfig.liveness_ttl_ms);
  } catch (err) {
    console.warn(`[pipeline] walker: registry load failed, using defaults: ${(err as Error).message}`);
    walkerConfig = { ...DEFAULT_WALKER_CONFIG };
  }

  const providers = registry && registry.models.length > 0
    ? Array.from(new Set(registry.models.map((m) => m.provider)))
    : ['ollama', 'claude', 'openai', 'openrouter', 'gemini', 'gemini-cli', 'opencode', 'adk'] as ProviderName[];

  // Tier 1 — eager probe of the selected model's provider only. Unknown /
  // alias model ids that don't resolve degrade gracefully: no eager probe,
  // the background sweep still warms everything.
  const selectedProvider = selectedModel
    ? registry?.models.find((m) => m.id === selectedModel)?.provider
    : undefined;
  if (selectedProvider) {
    try {
      await isProviderAlive(selectedProvider);
    } catch { /* non-fatal — walker treats unknown as alive */ }
  }

  // Tier 2 — full sweep, detached. Never awaited, no cap.
  void prefetchLiveness(providers).catch((err) => {
    console.warn(`[pipeline] liveness sweep (background) failed: ${(err as Error).message}`);
  });

  return walkerConfig;
}
