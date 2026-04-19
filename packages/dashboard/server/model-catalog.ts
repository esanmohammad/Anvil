/**
 * Model catalog — single source of truth for per-model token limits.
 *
 * Resolution order (first match wins):
 *   1. ENV override — `ANVIL_CONTEXT_WINDOW_<sanitized-model-id>` (e.g. `ANVIL_CONTEXT_WINDOW_CLAUDE_OPUS_4_7=1000000`)
 *   2. Explicit override table — for models that diverge from their family defaults (legacy 200K variants)
 *   3. Family rules — regex match on model ID, ordered from most specific to least
 *   4. OpenRouter-style `org/model` — recurse on the model segment
 *   5. Conservative DEFAULT
 *
 * Source: https://docs.claude.com/en/docs/about-claude/models/overview
 * (Opus 4.7, Opus 4.6, and Sonnet 4.6 all ship with native 1M context windows;
 * Haiku 4.5 stays at 200K. Legacy Sonnet/Opus 4.5 and earlier remain 200K.)
 *
 * To refresh limits without code changes, set env vars or edit OVERRIDES below.
 * Programmatic refresh path: Anthropic Models API exposes `max_input_tokens` per model.
 */

export interface ModelSpec {
  contextWindow: number;
  maxOutput: number;
}

/** Conservative default for completely unknown model IDs. */
export const DEFAULT_SPEC: ModelSpec = { contextWindow: 128_000, maxOutput: 16_000 };

/**
 * Exceptions to family rules. Only list a model here when it differs from its
 * family default (e.g. a 200K legacy variant whose family now defaults to 1M).
 */
const OVERRIDES: Record<string, ModelSpec> = {
  // Legacy Claude models that kept 200K
  'claude-sonnet-4-5': { contextWindow: 200_000, maxOutput: 64_000 },
  'claude-sonnet-4-5-20250929': { contextWindow: 200_000, maxOutput: 64_000 },
  'claude-opus-4-5': { contextWindow: 200_000, maxOutput: 64_000 },
  'claude-opus-4-5-20251101': { contextWindow: 200_000, maxOutput: 64_000 },
  'claude-opus-4-1': { contextWindow: 200_000, maxOutput: 32_000 },
  'claude-opus-4-1-20250805': { contextWindow: 200_000, maxOutput: 32_000 },
  'claude-sonnet-4-20250514': { contextWindow: 200_000, maxOutput: 64_000 },
  'claude-opus-4-20250514': { contextWindow: 200_000, maxOutput: 32_000 },
  'claude-3-5-sonnet': { contextWindow: 200_000, maxOutput: 8_000 },
  'claude-3-opus': { contextWindow: 200_000, maxOutput: 4_000 },
  'claude-3-haiku-20240307': { contextWindow: 200_000, maxOutput: 4_000 },
};

/**
 * Family rules — tried in order. First match wins.
 * Add new families here rather than enumerating individual model IDs.
 */
const FAMILY_RULES: Array<{ pattern: RegExp; spec: ModelSpec }> = [
  // Claude Haiku (all versions): 200K — stayed at 200K through 4.5
  { pattern: /(^|[^a-z])haiku/i, spec: { contextWindow: 200_000, maxOutput: 64_000 } },

  // Claude Opus / Sonnet — current generation is 1M native (Opus 4.6+, Sonnet 4.6+, aliases)
  // Covers: `opus`, `sonnet`, `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-7[1m]`, etc.
  { pattern: /^(claude-)?(opus|sonnet)(-|$|\[)/i, spec: { contextWindow: 1_000_000, maxOutput: 64_000 } },
  { pattern: /^claude-(opus|sonnet)-/i, spec: { contextWindow: 1_000_000, maxOutput: 64_000 } },

  // Catch-all for any other claude-* model — assume modern 1M, override above if legacy
  { pattern: /^claude-/i, spec: { contextWindow: 1_000_000, maxOutput: 64_000 } },

  // Gemini 2.x+ — 1M native
  { pattern: /^gemini-[2-9]/i, spec: { contextWindow: 1_000_000, maxOutput: 64_000 } },
  { pattern: /^gemini/i, spec: { contextWindow: 1_000_000, maxOutput: 32_000 } },

  // OpenAI reasoning (o1, o3, o4...) — 200K
  { pattern: /^o[1-9](-|$)/i, spec: { contextWindow: 200_000, maxOutput: 100_000 } },

  // OpenAI GPT-4.x / 4o — 128K
  { pattern: /^gpt-4/i, spec: { contextWindow: 128_000, maxOutput: 16_000 } },
];

/** Sanitize model ID into an env-var-safe key. */
function envKeyFor(modelId: string): string {
  return `ANVIL_CONTEXT_WINDOW_${modelId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
}

/** Resolve the full spec (context window + max output) for a model ID. */
export function getModelSpec(modelId: string): ModelSpec {
  // 1. ENV override — operator tuning without redeploy
  const envVal = process.env[envKeyFor(modelId)];
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return { ...DEFAULT_SPEC, contextWindow: n };
  }

  // 2. Explicit override for legacy variants
  if (OVERRIDES[modelId]) return OVERRIDES[modelId];

  // 3. Family rules
  for (const { pattern, spec } of FAMILY_RULES) {
    if (pattern.test(modelId)) return spec;
  }

  // 4. OpenRouter-style `org/model` — recurse on the model segment
  if (modelId.includes('/')) {
    const segment = modelId.split('/').slice(-1)[0];
    if (segment && segment !== modelId) return getModelSpec(segment);
  }

  return DEFAULT_SPEC;
}

/** Context window (input tokens) for a model ID. */
export function getContextWindow(modelId: string): number {
  return getModelSpec(modelId).contextWindow;
}

/** Max output tokens for a model ID. */
export function getMaxOutput(modelId: string): number {
  return getModelSpec(modelId).maxOutput;
}
