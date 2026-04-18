/**
 * OpenRouter adapter — extends OpenAIAdapter with OpenRouter-specific defaults.
 *
 * OpenRouter is an OpenAI-compatible API aggregator that provides access to
 * models from many providers (Anthropic, Google, Meta, etc.) through a single
 * unified API.
 */

import type { ProviderName } from './types.js';
import { OpenAIAdapter } from './openai-adapter.js';

// ---------------------------------------------------------------------------
// Pricing for well-known OpenRouter models: [inputPer1M, outputPer1M]
// ---------------------------------------------------------------------------

const OPENROUTER_PRICING: Record<string, [number, number]> = {
  'openai/gpt-4o':                     [2.5, 10.0],
  'anthropic/claude-sonnet-4':         [3.0, 15.0],
  'google/gemini-2.5-flash':           [0.30, 2.50],
  'meta-llama/llama-3-70b-instruct':   [0.59, 0.79],
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenRouterAdapter extends OpenAIAdapter {
  override readonly provider: ProviderName = 'openrouter';

  // -- Configuration overrides ----------------------------------------------

  protected override getApiKey(): string | undefined {
    return process.env.OPENROUTER_API_KEY;
  }

  protected override getBaseUrl(): string {
    return process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  }

  protected override getExtraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://anvil.dev',
      'X-Title': 'Anvil',
    };
  }

  // -- Model support --------------------------------------------------------

  override supportsModel(modelId: string): boolean {
    // OpenRouter model IDs contain a slash: provider/model
    return modelId.includes('/');
  }

  override getModelPricing(modelId: string): [number, number] | null {
    return OPENROUTER_PRICING[modelId] ?? null;
  }

  // -- Availability ---------------------------------------------------------

  override async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const key = this.getApiKey();
    if (!key) {
      return { available: false, error: 'OPENROUTER_API_KEY is not set' };
    }
    return { available: true };
  }
}
