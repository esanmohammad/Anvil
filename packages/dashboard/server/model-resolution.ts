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
import { createRequire } from 'node:module';
import { pickAliveModelFromChainSync, prefetchLiveness, setLivenessTtlMs } from './provider-liveness.js';
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
      console.warn(
        `[pipeline] ${stageName}: ${picked.fellBackFrom} skipped; falling back to ${picked.model}`,
      );
      const key = `${stageName}|${picked.fellBackFrom}->${picked.model}`;
      if (!deps.livenessFallbackNotified.has(key)) {
        deps.livenessFallbackNotified.add(key);
        deps.emitProjectEvent({
          source: 'routing',
          message: `${picked.fellBackFrom} unavailable for ${stageName} (provider auth/liveness); falling back to ${picked.model}`,
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
 * Per-stage tool-permission set. Resolution:
 *   1. Built-in `STAGE_TOOL_PERMISSIONS` + `STAGE_WEB_PERMISSIONS`.
 *   2. factory.yaml `allow_tools` extends, `deny_tools` strips.
 *   3. pipeline-policy.overlay.json `tools.{network,browseHeadless,
 *      browseEval,browsePixel}` blocks: `enabled: false` strips the
 *      whole class for this stage; `stages: [...]` replaces the
 *      stage allow-list (stages NOT in the array lose the class).
 * Empty result falls back to read-only.
 */
export function allowedToolsForCurrentStage(deps: ModelResolutionDeps, stageName: string): string[] {
  const base = new Set(allowedToolsForStage(stageName));
  const overrides = deps.projectLoader
    .getConfig(deps.config.project)?.pipeline?.permissions?.[stageName];
  if (overrides?.allow_tools) for (const t of overrides.allow_tools) base.add(t);
  if (overrides?.deny_tools) for (const t of overrides.deny_tools) base.delete(t);

  // H10-followup #1 — apply pipeline-policy overlay's tools.* gating.
  applyToolsOverlay(deps, stageName, base);

  if (base.size === 0) return ['read_file', 'grep', 'glob', 'list'];
  return [...base].sort();
}

const WEB_TOOLS_BY_OVERLAY_KEY: Record<string, readonly string[]> = {
  network: ['web_search', 'web_fetch'],
  browseHeadless: [
    'browser_navigate', 'browser_click', 'browser_input', 'browser_scroll',
    'browser_search_page', 'browser_extract', 'browser_screenshot',
    'browser_console_messages', 'browser_network_requests',
    'browser_new_tab', 'browser_close_tab', 'browser_tabs',
    'browser_done', 'browser_attach_context',
  ],
  browseEval: ['browser_evaluate'],
  browsePixel: ['computer_use'],
};

function applyToolsOverlay(deps: ModelResolutionDeps, stageName: string, allowed: Set<string>): void {
  // Lazy-load policy + overlay; failures degrade to "no overlay" rather
  // than throwing — the user never sees a stage permission resolution
  // turn into a hard failure.
  let toolsPolicy: Record<string, { enabled?: boolean; stages?: string[] }> | undefined;
  try {
    // The dashboard injects loadPolicy via deps elsewhere; require it
    // via a synchronous CJS shim so this resolver stays a pure
    // function. `import.meta.url` is a stable anchor for createRequire.
    const req = createRequire(import.meta.url);
    const { loadPolicy } = req('./pipeline-policy.js') as typeof import('./pipeline-policy.js');
    // ANVIL_HOME defaults to ~/.anvil; loadPolicy reads from
    // <home>/projects/<slug>/pipeline-policy.overlay.json. The
    // dashboard sets ANVIL_HOME on the env at boot.
    const home = process.env.ANVIL_HOME ?? `${process.env.HOME ?? ''}/.anvil`;
    const policy = loadPolicy(deps.config.project, home);
    toolsPolicy = (policy as { tools?: Record<string, { enabled?: boolean; stages?: string[] }> }).tools;
  } catch { /* no policy / not available — leave allowed unchanged */ }

  if (!toolsPolicy) return;

  for (const [key, toolNames] of Object.entries(WEB_TOOLS_BY_OVERLAY_KEY)) {
    const block = toolsPolicy[key];
    if (!block) continue;
    if (block.enabled === false) {
      for (const t of toolNames) allowed.delete(t);
      continue;
    }
    if (Array.isArray(block.stages) && !block.stages.includes(stageName)) {
      // stages override: this stage isn't in the explicit list → strip.
      for (const t of toolNames) allowed.delete(t);
    }
  }
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
 * `~/.anvil/models.yaml`. Probes run in parallel; failures are
 * non-fatal. Returns the resolved walker config so the caller can
 * thread it through stage-fallback and retry loops.
 */
export async function prefetchProviderLiveness(): Promise<WalkerConfig> {
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
  await prefetchLiveness(providers);
  return walkerConfig;
}
