/// <reference types="node" />

/**
 * ContextOverflowDetector — estimates token usage and triggers warnings/compression.
 *
 * Token limits are resolved via the family-rule catalog (see `resolveTokenLimit`),
 * driven by env-var overrides + family patterns, so new model versions work
 * without code changes.
 */

export interface ContextOverflowConfig {
  /** Token limit for the model. Falls back to a conservative default if unknown. */
  tokenLimit: number;
  /** Warn at this fraction of the limit. Default 0.6. */
  warnThreshold: number;
  /** Trigger compression at this fraction. Default 0.8. */
  compressThreshold: number;
  /** Characters per token estimate. Default 4. */
  charsPerToken: number;
}

export interface ContextStatus {
  estimatedTokens: number;
  tokenLimit: number;
  usagePercent: number;
  level: 'ok' | 'warning' | 'critical';
  shouldCompress: boolean;
}

// Conservative default for models we can't identify at all.
const DEFAULT_TOKEN_LIMIT = 128_000;

const DEFAULT_CONFIG: ContextOverflowConfig = {
  tokenLimit: DEFAULT_TOKEN_LIMIT,
  warnThreshold: 0.6,
  compressThreshold: 0.8,
  charsPerToken: 4,
};

/**
 * Family rules for resolving token limits without enumerating every model ID.
 * Mirrors dashboard's `model-catalog.ts` — kept in sync but duplicated to avoid
 * a cross-package import (cli and dashboard are separate workspaces).
 * Source: https://docs.claude.com/en/docs/about-claude/models/overview
 */
const FAMILY_RULES: Array<{ pattern: RegExp; limit: number }> = [
  { pattern: /(^|[^a-z])haiku/i, limit: 200_000 },
  { pattern: /^(claude-)?(opus|sonnet)(-|$|\[)/i, limit: 1_000_000 },
  { pattern: /^claude-(opus|sonnet)-/i, limit: 1_000_000 },
  { pattern: /^claude-/i, limit: 1_000_000 },
  { pattern: /^gemini-[2-9]/i, limit: 1_000_000 },
  { pattern: /^gemini/i, limit: 1_000_000 },
  { pattern: /^o[1-9](-|$)/i, limit: 200_000 },
  { pattern: /^gpt-4/i, limit: 128_000 },
];

/** Overrides for legacy models that diverge from their family's current default. */
const LIMIT_OVERRIDES: Record<string, number> = {
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-5-20251101': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4-1-20250805': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-3.5-sonnet': 200_000,
  'claude-3-opus': 200_000,
};

/** Resolve token limit: env override → explicit override → family rule → default. */
export function resolveTokenLimit(modelId: string): number {
  const envKey = `ANVIL_CONTEXT_WINDOW_${modelId.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (LIMIT_OVERRIDES[modelId]) return LIMIT_OVERRIDES[modelId];
  for (const { pattern, limit } of FAMILY_RULES) {
    if (pattern.test(modelId)) return limit;
  }
  if (modelId.includes('/')) {
    const segment = modelId.split('/').slice(-1)[0];
    if (segment && segment !== modelId) return resolveTokenLimit(segment);
  }
  return DEFAULT_TOKEN_LIMIT;
}

export class ContextOverflowDetector {
  private config: ContextOverflowConfig;

  constructor(config?: Partial<ContextOverflowConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Create a detector configured for a specific model. */
  static forModel(model: string, overrides?: Partial<ContextOverflowConfig>): ContextOverflowDetector {
    return new ContextOverflowDetector({ tokenLimit: resolveTokenLimit(model), ...overrides });
  }

  /** Estimate token count from a string. */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / this.config.charsPerToken);
  }

  /** Check context status given current content. */
  check(content: string): ContextStatus {
    const estimatedTokens = this.estimateTokens(content);
    const usagePercent = estimatedTokens / this.config.tokenLimit;

    let level: ContextStatus['level'] = 'ok';
    if (usagePercent >= this.config.compressThreshold) {
      level = 'critical';
    } else if (usagePercent >= this.config.warnThreshold) {
      level = 'warning';
    }

    return {
      estimatedTokens,
      tokenLimit: this.config.tokenLimit,
      usagePercent,
      level,
      shouldCompress: usagePercent >= this.config.compressThreshold,
    };
  }

  /** Get the configured token limit. */
  getTokenLimit(): number {
    return this.config.tokenLimit;
  }
}
