// Cost-aware model routing per pipeline stage
//
// Uses weight classes (fast/balanced/powerful) instead of hardcoded model IDs.
// Model IDs are resolved at runtime via a pluggable resolver function,
// so new models are picked up without code changes.

export type ModelTier = 'fast' | 'balanced' | 'thorough';
type WeightClass = 'fast' | 'balanced' | 'powerful';

export interface ModelRouting {
  clarify: string;
  requirements: string;
  'project-requirements': string;
  specs: string;
  tasks: string;
  build: string;
  validate: string;
  ship: string;
}

// Per-stage weight class assignments for each tier (no model IDs here)
const STAGE_WEIGHTS: Record<ModelTier, Record<keyof ModelRouting, WeightClass>> = {
  fast: {
    clarify: 'fast',
    requirements: 'fast',
    'project-requirements': 'fast',
    specs: 'fast',
    tasks: 'fast',
    build: 'balanced',
    validate: 'fast',
    ship: 'fast',
  },
  balanced: {
    clarify: 'fast',
    requirements: 'balanced',
    'project-requirements': 'balanced',
    specs: 'balanced',
    tasks: 'fast',
    build: 'balanced',
    validate: 'balanced',
    ship: 'fast',
  },
  thorough: {
    clarify: 'balanced',
    requirements: 'balanced',
    'project-requirements': 'balanced',
    specs: 'powerful',
    tasks: 'balanced',
    build: 'balanced',
    validate: 'balanced',
    ship: 'balanced',
  },
};

// ── Model resolver ────────────────────────────────────────────────────

// Default resolver used when no external registry is configured.
// Maps weight classes to well-known model IDs as a last resort.
let modelResolver: (weight: WeightClass) => string = defaultResolver;

function defaultResolver(weight: WeightClass): string {
  // These are fallbacks only — the dashboard and CLI should inject
  // a resolver from the provider registry at startup.
  switch (weight) {
    case 'fast': return 'claude-haiku-4-5-20251001';
    case 'balanced': return 'claude-sonnet-4-6';
    case 'powerful': return 'claude-opus-4-6';
  }
}

/**
 * Inject a custom model resolver (e.g., from the provider registry).
 * The resolver receives a weight class and returns the best available model ID.
 */
export function setModelResolver(resolver: (weight: WeightClass) => string): void {
  modelResolver = resolver;
}

// Map stage names that might vary
const STAGE_NAME_ALIASES: Record<string, keyof ModelRouting> = {
  'clarify': 'clarify',
  'requirements': 'requirements',
  'project-requirements': 'project-requirements',
  'repo-requirements': 'project-requirements',
  'specs': 'specs',
  'tasks': 'tasks',
  'build': 'build',
  'validate': 'validate',
  'ship': 'ship',
};

export interface ModelRoutingConfig {
  default?: string;
  [stage: string]: string | undefined;
}

export function getModelForStage(
  stage: string,
  tier: ModelTier,
  configModels?: ModelRoutingConfig,
): string {
  const normalizedStage = STAGE_NAME_ALIASES[stage] ?? stage;

  // 1. Check factory.yaml pipeline.models for stage-specific override
  if (configModels?.[normalizedStage]) {
    return configModels[normalizedStage]!;
  }

  // 2. Check factory.yaml pipeline.models.default for unknown stages
  const stageKey = normalizedStage as keyof ModelRouting;
  if (configModels?.default && !(stageKey in STAGE_WEIGHTS[tier])) {
    return configModels.default;
  }

  // 3. Resolve via weight class → model ID
  const weight = STAGE_WEIGHTS[tier][stageKey] ?? 'balanced';
  return modelResolver(weight);
}

export function getModelRoutingForTier(tier: ModelTier): ModelRouting {
  const weights = STAGE_WEIGHTS[tier];
  const routing: Partial<ModelRouting> = {};
  for (const [stage, weight] of Object.entries(weights)) {
    routing[stage as keyof ModelRouting] = modelResolver(weight);
  }
  return routing as ModelRouting;
}

// Agentic stages that require tool use (file read/write, shell execution)
const AGENTIC_STAGES = ['build', 'validate', 'ship'];

/**
 * Resolve which provider to use for a given stage.
 * Agentic stages (build/validate/ship) enforce 'claude' or 'gemini-cli' or 'adk'.
 */
export function getProviderForStage(
  stage: string,
  configProviders?: Record<string, string>,
): string {
  const normalizedStage = STAGE_NAME_ALIASES[stage] ?? stage;

  // Stage-specific override from factory.yaml pipeline.providers
  if (configProviders?.[normalizedStage]) {
    const provider = configProviders[normalizedStage];
    // Enforce agentic providers for build/validate/ship
    if (AGENTIC_STAGES.includes(normalizedStage) && !['claude', 'gemini-cli', 'adk'].includes(provider)) {
      return 'claude'; // fallback — these stages need tool use
    }
    return provider;
  }

  // Default provider
  if (configProviders?.default) {
    const provider = configProviders.default;
    if (AGENTIC_STAGES.includes(normalizedStage) && !['claude', 'gemini-cli', 'adk'].includes(provider)) {
      return 'claude';
    }
    return provider;
  }

  return 'claude';
}
