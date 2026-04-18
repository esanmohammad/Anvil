// Cost-aware model routing per pipeline stage

export type ModelTier = 'fast' | 'balanced' | 'thorough';

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

// Tier-based default model assignments
const TIER_DEFAULTS: Record<ModelTier, ModelRouting> = {
  fast: {
    clarify: 'claude-haiku-4-5-20251001',
    requirements: 'claude-haiku-4-5-20251001',
    'project-requirements': 'claude-haiku-4-5-20251001',
    specs: 'claude-haiku-4-5-20251001',
    tasks: 'claude-haiku-4-5-20251001',
    build: 'claude-sonnet-4-6',
    validate: 'claude-haiku-4-5-20251001',
    ship: 'claude-haiku-4-5-20251001',
  },
  balanced: {
    clarify: 'claude-haiku-4-5-20251001',
    requirements: 'claude-sonnet-4-6',
    'project-requirements': 'claude-sonnet-4-6',
    specs: 'claude-sonnet-4-6',
    tasks: 'claude-haiku-4-5-20251001',
    build: 'claude-sonnet-4-6',
    validate: 'claude-sonnet-4-6',
    ship: 'claude-haiku-4-5-20251001',
  },
  thorough: {
    clarify: 'claude-sonnet-4-6',
    requirements: 'claude-sonnet-4-6',
    'project-requirements': 'claude-sonnet-4-6',
    specs: 'claude-opus-4-6',
    tasks: 'claude-sonnet-4-6',
    build: 'claude-sonnet-4-6',
    validate: 'claude-sonnet-4-6',
    ship: 'claude-sonnet-4-6',
  },
};

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

  // 2. Check factory.yaml pipeline.models.default
  if (configModels?.default) {
    // Use default for stages not explicitly in tier routing
    const tierRouting = TIER_DEFAULTS[tier];
    const stageName = normalizedStage as keyof ModelRouting;
    if (!(stageName in tierRouting)) {
      return configModels.default;
    }
  }

  // 3. Apply tier-based defaults
  const tierRouting = TIER_DEFAULTS[tier];
  const stageName = normalizedStage as keyof ModelRouting;
  if (stageName in tierRouting) {
    return tierRouting[stageName];
  }

  // 4. Fallback
  return configModels?.default ?? 'claude-sonnet-4-6';
}

export function getModelRoutingForTier(tier: ModelTier): ModelRouting {
  return { ...TIER_DEFAULTS[tier] };
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
