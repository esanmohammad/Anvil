/**
 * Provider registry — singleton that manages all model adapters.
 *
 * Adapters are registered synchronously at construction time.
 * The registry can resolve the correct adapter from a model ID string,
 * enforce tier requirements for agentic stages, and check availability
 * of all registered providers.
 */

import type { ModelAdapter, ProviderName, ProviderTier } from './types.js';

const AGENTIC_STAGES = new Set(['build', 'validate', 'ship']);

export class ProviderRegistry {
  private adapters = new Map<ProviderName, ModelAdapter>();
  private static instance: ProviderRegistry | null = null;
  private initialized = false;

  /* ------------------------------------------------------------------ */
  /*  Singleton                                                          */
  /* ------------------------------------------------------------------ */

  static getInstance(): ProviderRegistry {
    if (!this.instance) {
      this.instance = new ProviderRegistry();
    }
    if (!this.instance.initialized) {
      this.instance.registerDefaults();
    }
    return this.instance;
  }

  /** Reset the singleton (useful for tests). */
  static reset(): void {
    this.instance = null;
  }

  /* ------------------------------------------------------------------ */
  /*  Registration                                                       */
  /* ------------------------------------------------------------------ */

  register(adapter: ModelAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ProviderName): ModelAdapter | undefined {
    return this.adapters.get(provider);
  }

  all(): ModelAdapter[] {
    return [...this.adapters.values()];
  }

  /* ------------------------------------------------------------------ */
  /*  Resolution                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Auto-detect provider from a model ID string.
   *
   * Rules (evaluated in order):
   *  - `claude-*`, contains `sonnet`/`opus`/`haiku` -> claude
   *  - `gpt-*`, `o1*`, `o3*`, `o4*`, `chatgpt-*`  -> openai
   *  - `gemini-*`                                    -> gemini
   *  - contains `/` (e.g. `anthropic/claude-sonnet-4`) -> openrouter
   *  - no match                                      -> claude (default)
   */
  resolveFromModelId(modelId: string): ProviderName {
    const id = modelId.toLowerCase();

    // Claude patterns
    if (id.startsWith('claude-') || /\b(sonnet|opus|haiku)\b/.test(id)) {
      return 'claude';
    }

    // OpenAI patterns
    if (
      id.startsWith('gpt-') ||
      id.startsWith('o1') ||
      id.startsWith('o3') ||
      id.startsWith('o4') ||
      id.startsWith('chatgpt-')
    ) {
      return 'openai';
    }

    // Gemini patterns
    if (id.startsWith('gemini-')) {
      return 'gemini';
    }

    // OpenRouter uses `org/model` format
    if (id.includes('/')) {
      return 'openrouter';
    }

    // Default to Claude
    return 'claude';
  }

  /**
   * Resolve the adapter for a given stage, honouring tier enforcement.
   *
   * For agentic stages (`build`, `validate`, `ship`) the resolved adapter
   * MUST have `tier === 'agentic'`. If it doesn't, we log a warning and
   * fall back to the Claude adapter which is always agentic.
   */
  resolveForStage(
    stage: string,
    modelId: string,
    providerOverride?: ProviderName,
  ): { adapter: ModelAdapter; provider: ProviderName; warning?: string } {
    const providerName = providerOverride ?? this.resolveFromModelId(modelId);
    let adapter = this.adapters.get(providerName);

    // If the requested provider isn't registered, fall back to claude
    if (!adapter) {
      const claude = this.adapters.get('claude');
      if (!claude) {
        throw new Error(
          `Provider "${providerName}" is not registered and no fallback (claude) is available.`,
        );
      }
      return {
        adapter: claude,
        provider: 'claude',
        warning: `Provider "${providerName}" is not registered — falling back to claude.`,
      };
    }

    // Tier enforcement for agentic stages
    if (AGENTIC_STAGES.has(stage) && adapter.capabilities.tier !== 'agentic') {
      const claude = this.adapters.get('claude');
      if (claude && claude.capabilities.tier === 'agentic') {
        return {
          adapter: claude,
          provider: 'claude',
          warning:
            `Stage "${stage}" requires an agentic provider, but ` +
            `"${providerName}" is tier="${adapter.capabilities.tier}". ` +
            `Falling back to claude.`,
        };
      }
      // If even claude isn't agentic (shouldn't happen), proceed with a warning
      return {
        adapter,
        provider: providerName,
        warning:
          `Stage "${stage}" requires an agentic provider, but ` +
          `"${providerName}" is tier="${adapter.capabilities.tier}". ` +
          `No agentic fallback available — proceeding anyway.`,
      };
    }

    return { adapter, provider: providerName };
  }

  /* ------------------------------------------------------------------ */
  /*  Health check                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Check availability of all registered adapters.
   * Returns a map of provider name to check result.
   */
  async checkAll(): Promise<
    Map<ProviderName, { available: boolean; version?: string; error?: string; tier: ProviderTier }>
  > {
    const results = new Map<
      ProviderName,
      { available: boolean; version?: string; error?: string; tier: ProviderTier }
    >();

    const checks = this.all().map(async (adapter) => {
      try {
        const result = await adapter.checkAvailability();
        results.set(adapter.provider, {
          ...result,
          tier: adapter.capabilities.tier,
        });
      } catch (err) {
        results.set(adapter.provider, {
          available: false,
          error: err instanceof Error ? err.message : String(err),
          tier: adapter.capabilities.tier,
        });
      }
    });

    await Promise.all(checks);
    return results;
  }

  /* ------------------------------------------------------------------ */
  /*  Default registration                                               */
  /* ------------------------------------------------------------------ */

  private registerDefaults(): void {
    this.initialized = true;

    // Synchronous imports — each adapter is just a class definition with no
    // heavy side effects. We wrap each in try/catch so a missing optional
    // dependency doesn't crash the whole registry.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ClaudeAdapter } = require('./claude-adapter.js');
      this.register(new ClaudeAdapter());
    } catch { /* claude adapter unavailable */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenAIAdapter } = require('./openai-adapter.js');
      this.register(new OpenAIAdapter());
    } catch { /* openai adapter unavailable */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GeminiAdapter } = require('./gemini-adapter.js');
      this.register(new GeminiAdapter());
    } catch { /* gemini adapter unavailable */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OpenRouterAdapter } = require('./openrouter-adapter.js');
      this.register(new OpenRouterAdapter());
    } catch { /* openrouter adapter unavailable */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OllamaAdapter } = require('./ollama-adapter.js');
      this.register(new OllamaAdapter());
    } catch { /* ollama adapter unavailable */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GeminiCliAdapter } = require('./gemini-cli-adapter.js');
      this.register(new GeminiCliAdapter());
    } catch { /* gemini-cli adapter unavailable */ }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AdkAdapter } = require('./adk-adapter.js');
      this.register(new AdkAdapter());
    } catch { /* adk adapter unavailable */ }
  }
}
