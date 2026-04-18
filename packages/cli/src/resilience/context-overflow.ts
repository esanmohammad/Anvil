/**
 * ContextOverflowDetector — estimates token usage and triggers warnings/compression.
 */

export interface ContextOverflowConfig {
  /** Token limit for the model. Default 200_000. */
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

const DEFAULT_CONFIG: ContextOverflowConfig = {
  tokenLimit: 200_000,
  warnThreshold: 0.6,
  compressThreshold: 0.8,
  charsPerToken: 4,
};

/** Per-model token limits. */
export const MODEL_TOKEN_LIMITS: Record<string, number> = {
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-3.5-sonnet': 200_000,
  'claude-3-opus': 200_000,
  'gpt-4': 128_000,
  'gpt-4-turbo': 128_000,
};

export class ContextOverflowDetector {
  private config: ContextOverflowConfig;

  constructor(config?: Partial<ContextOverflowConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Create a detector configured for a specific model. */
  static forModel(model: string, overrides?: Partial<ContextOverflowConfig>): ContextOverflowDetector {
    const tokenLimit = MODEL_TOKEN_LIMITS[model] ?? DEFAULT_CONFIG.tokenLimit;
    return new ContextOverflowDetector({ tokenLimit, ...overrides });
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
