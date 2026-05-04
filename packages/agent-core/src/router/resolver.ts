/**
 * Resolver — given a capability + complexity + tier preference list, walks
 * the model registry and returns a routing chain `{ primary, fallbacks }`
 * suitable for `LlmRouter.invoke`.
 *
 * Pure function. No I/O. No mutation of the registry.
 *
 * Algorithm:
 *   1. Filter: model.capabilities ⊇ {capability}
 *              ∧ rank(complexity) ≤ rank(model.complexity_max)
 *              ∧ availability[model.id]?.available !== false
 *              ∧ context_tokens, if requested, ≤ model.context_tokens
 *   2. Group by tier
 *   3. Walk tiers in `prefer` order; within tier, yaml-declared order
 *   4. Concatenate → [primary, ...fallbacks]
 *   5. If empty → ModelResolutionError with per-step diagnostic counts
 */
import type {
  ModelRegistry,
  ModelCapability,
  ModelComplexity,
  ModelTier,
  ModelEntry,
} from './model-registry.js';
import type { RouteFallback } from './types.js';

export interface ResolveModelOptions {
  capability: ModelCapability;
  complexity: ModelComplexity;
  /** Tier preference order. Walked left-to-right; first non-empty tier wins. */
  prefer: ModelTier[];
  /** Optional minimum context window required by the call. */
  minContextTokens?: number;
}

export interface ResolvedChain {
  primary: string;
  fallbacks: RouteFallback[];
}

export class ModelResolutionError extends Error {
  constructor(
    public readonly opts: ResolveModelOptions,
    public readonly diagnostic: ResolutionDiagnostic,
  ) {
    super(formatDiagnostic(opts, diagnostic));
    this.name = 'ModelResolutionError';
  }
}

export interface ResolutionDiagnostic {
  totalInRegistry: number;
  matchedCapability: number;
  matchedComplexity: number;
  matchedContext: number;
  matchedAvailability: number;
}

const COMPLEXITY_RANK: Record<ModelComplexity, number> = { S: 1, M: 2, L: 3 };

export function resolveModel(opts: ResolveModelOptions, registry: ModelRegistry): ResolvedChain {
  const requested = COMPLEXITY_RANK[opts.complexity];
  const diag: ResolutionDiagnostic = {
    totalInRegistry: registry.models.length,
    matchedCapability: 0,
    matchedComplexity: 0,
    matchedContext: 0,
    matchedAvailability: 0,
  };

  const passed: ModelEntry[] = [];
  for (const m of registry.models) {
    if (!m.capabilities.includes(opts.capability)) continue;
    diag.matchedCapability += 1;

    if (COMPLEXITY_RANK[m.complexity_max] < requested) continue;
    diag.matchedComplexity += 1;

    if (
      opts.minContextTokens !== undefined &&
      m.context_tokens !== undefined &&
      m.context_tokens < opts.minContextTokens
    ) {
      continue;
    }
    diag.matchedContext += 1;

    if (registry.availability?.get(m.id)?.available === false) continue;
    diag.matchedAvailability += 1;

    passed.push(m);
  }

  // Walk tier preference. Within a tier, preserve yaml-declared order
  // (which is the order they appear in registry.models, since `passed`
  // is built by iterating registry.models in order and we keep that).
  const ordered: ModelEntry[] = [];
  for (const tier of opts.prefer) {
    for (const m of passed) {
      if (m.tier === tier) ordered.push(m);
    }
  }

  if (ordered.length === 0) {
    throw new ModelResolutionError(opts, diag);
  }

  return {
    primary: ordered[0].id,
    fallbacks: ordered.slice(1).map((m) => ({ model: m.id })),
  };
}

function formatDiagnostic(opts: ResolveModelOptions, d: ResolutionDiagnostic): string {
  const lines = [
    `no model matches {capability: ${opts.capability}, complexity: ${opts.complexity}, prefer: [${opts.prefer.join(', ')}]}`,
    `  registry has ${d.totalInRegistry} model(s);`,
    `  ${d.matchedCapability} satisfied capability,`,
    `  ${d.matchedComplexity} also satisfied complexity_max,`,
    `  ${d.matchedContext} also satisfied context_tokens,`,
    `  ${d.matchedAvailability} were available.`,
    `  hint: add a matching model to ~/.anvil/models.yaml,`,
    `        or relax stage policy to a less strict capability/complexity.`,
  ];
  return lines.join('\n');
}
