/**
 * Dynamic model tier resolver — resolves model IDs from the provider registry
 * instead of hardcoding them. When Claude (or any provider) releases new models,
 * only the provider registry needs updating.
 *
 * Tier routing strategy defines which "weight class" each stage needs:
 *   fast     → cheap model for most stages, balanced for build
 *   balanced → mix of cheap and mid-range
 *   thorough → mid-range for most, powerful for specs
 *
 * The resolver looks up the best available model for each weight class
 * from the cached provider registry discovery result.
 */

import type { ModelInfo, DiscoveryResult } from './provider-registry.js';

export type ModelTier = 'fast' | 'balanced' | 'thorough';

// Weight class = the performance tier from the provider registry
type WeightClass = 'fast' | 'balanced' | 'powerful';

/**
 * Per-stage weight class assignments for each user-selected tier.
 * This is the routing strategy — it says "for the 'balanced' tier,
 * the build stage needs a 'balanced' model, clarify needs a 'fast' one", etc.
 *
 * This table never contains model IDs — only weight classes.
 */
const STAGE_WEIGHTS: Record<ModelTier, Record<string, WeightClass>> = {
  fast: {
    clarify:               'fast',
    requirements:          'fast',
    'repo-requirements':   'fast',
    specs:                 'fast',
    tasks:                 'fast',
    build:                 'balanced',
    validate:              'fast',
    ship:                  'fast',
  },
  balanced: {
    clarify:               'fast',
    requirements:          'balanced',
    'repo-requirements':   'balanced',
    specs:                 'balanced',
    tasks:                 'fast',
    build:                 'balanced',
    validate:              'balanced',
    ship:                  'fast',
  },
  thorough: {
    clarify:               'balanced',
    requirements:          'balanced',
    'repo-requirements':   'balanced',
    specs:                 'powerful',
    tasks:                 'balanced',
    build:                 'balanced',
    validate:              'balanced',
    ship:                  'balanced',
  },
};

// ── Cache for resolved models ──────────────────────────────────────────

let resolvedCache: Map<string, string> | null = null;
let lastDiscoveryResult: DiscoveryResult | null = null;

/**
 * Provide the discovery result so the resolver can look up available models.
 * Call this once after `discoverProviders()` completes.
 */
export function setDiscoveryResult(result: DiscoveryResult): void {
  if (result !== lastDiscoveryResult) {
    lastDiscoveryResult = result;
    resolvedCache = null; // invalidate on new discovery
  }
}

/**
 * Find the best available agentic model for a given weight class.
 * Prefers CLI providers (agentic capability) since pipeline stages need tool use.
 */
function findModelForWeight(weight: WeightClass, models: ModelInfo[]): string | null {
  // Only consider models with agentic capability (CLI providers)
  const agentic = models.filter(m => m.capabilities.includes('agentic'));

  // Exact tier match
  const exact = agentic.find(m => m.tier === weight);
  if (exact) return exact.id;

  // Fallback: if no exact match, try adjacent tiers
  // e.g., if no 'balanced' agentic model, try 'powerful' then 'fast'
  const fallbackOrder: Record<WeightClass, WeightClass[]> = {
    fast: ['balanced', 'powerful'],
    balanced: ['powerful', 'fast'],
    powerful: ['balanced', 'fast'],
  };

  for (const fallback of fallbackOrder[weight]) {
    const match = agentic.find(m => m.tier === fallback);
    if (match) return match.id;
  }

  // Last resort: any agentic model
  return agentic[0]?.id ?? null;
}

/**
 * Resolve the model ID for a given tier + stage combination.
 * Uses the provider registry to find the best available model dynamically.
 *
 * @param tier - User-selected cost tier (fast/balanced/thorough)
 * @param stageName - Pipeline stage name (clarify, build, etc.)
 * @param fallbackModel - Model to use if registry lookup fails
 */
export function resolveModelByTier(
  tier: ModelTier,
  stageName: string,
  fallbackModel: string,
): string {
  // Determine which weight class this stage needs
  const stageWeights = STAGE_WEIGHTS[tier];
  const weight = stageWeights[stageName] ?? 'balanced';

  // If we have a cached discovery result, resolve dynamically
  if (lastDiscoveryResult) {
    const cacheKey = `${tier}:${weight}`;

    if (!resolvedCache) resolvedCache = new Map();
    if (resolvedCache.has(cacheKey)) return resolvedCache.get(cacheKey)!;

    const resolved = findModelForWeight(weight, lastDiscoveryResult.models);
    if (resolved) {
      resolvedCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // No registry available — use fallback
  return fallbackModel;
}

/** Invalidate the resolver cache (e.g., after provider changes) */
export function invalidateResolverCache(): void {
  resolvedCache = null;
  lastDiscoveryResult = null;
}
