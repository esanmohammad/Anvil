/**
 * OpenAI HTTP API adapter — agentic, inherits the OpenAI-compatible
 * SSE loop from `OpenRouterAdapter`.
 *
 * OpenRouter / OpenCode Go / OpenAI all speak the same `/v1/chat/completions`
 * protocol. We use OpenRouter as the canonical implementation (SSE
 * `tool_calls` reassembly by `index`, `reasoning` + `reasoning_details`
 * echo-back for o-series / thinking models, `UpstreamError` with
 * retryable classification, per-call `AbortController` set, buffered
 * emitContent). This adapter just overrides the config knobs:
 *
 *   - `provider` flips to `'openai'`
 *   - API key reads from `OPENAI_API_KEY`
 *   - Base URL defaults to `https://api.openai.com/v1` (override with
 *     `OPENAI_BASE_URL` for proxies / Azure-OpenAI / etc.)
 *   - Drops OpenRouter's attribution headers (`HTTP-Referer`, `X-Title`)
 *   - Pricing fallback table maps the bare OpenAI ids
 *
 * Capability tier flips from `'function-calling'` → `'agentic'` because
 * the inherited SSE consumer drives a real `BuiltinToolExecutor` loop.
 * o1 / o3 / o4 reasoning models work out-of-the-box — the parent
 * captures `delta.reasoning` / `delta.reasoning_details` and replays
 * them on the next assistant turn (same protocol upstream uses).
 */

import type { ProviderName } from './types.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';

/**
 * Pricing fallbacks for known bare OpenAI ids.
 * `[inputPer1MTokens, outputPer1MTokens]`. The chat-completions response
 * doesn't echo `usage.cost`, so the inherited base class falls back to
 * this table when computing per-call cost.
 */
const OPENAI_PRICING: Record<string, [number, number]> = {
  // Current generation
  'gpt-4o':                 [2.5, 10.0],
  'gpt-4o-mini':            [0.15, 0.60],
  'gpt-4-turbo':            [10.0, 30.0],
  'gpt-4':                  [30.0, 60.0],
  'chatgpt-4o-latest':      [5.0, 15.0],
  // o-series reasoning models
  'o1':                     [15.0, 60.0],
  'o1-mini':                [3.0, 12.0],
  'o1-preview':             [15.0, 60.0],
  'o3':                     [10.0, 40.0],
  'o3-mini':                [1.1, 4.4],
  'o4-mini':                [1.1, 4.4],
};

export class OpenAIAdapter extends OpenRouterAdapter {
  override readonly provider: ProviderName = 'openai';

  // -- Configuration overrides ----------------------------------------------

  protected override getApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }

  protected override getBaseUrl(): string {
    // Default to api.openai.com. `OPENAI_BASE_URL` overrides for proxies,
    // Azure-OpenAI, or self-hosted OpenAI-compatible endpoints (vLLM,
    // LocalAI, etc.).
    return (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  protected override getExtraHeaders(): Record<string, string> {
    // OpenAI's API doesn't use the OpenRouter attribution headers.
    return {};
  }

  // -- Model id handling ----------------------------------------------------

  override supportsModel(modelId: string): boolean {
    // Match bare OpenAI ids — `gpt-*`, `chatgpt-*`, and the o-series.
    // OpenRouter slugs (`openai/gpt-4o`) deliberately fall through to
    // OpenRouterAdapter via the slash-routing in default-adapter-factory.
    return /^(gpt-|chatgpt-|o[134](-|$))/.test(modelId);
  }

  override getModelPricing(modelId: string): [number, number] | null {
    return OPENAI_PRICING[modelId] ?? null;
  }

  // -- Availability ---------------------------------------------------------

  override async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const key = this.getApiKey();
    if (!key) return { available: false, error: 'OPENAI_API_KEY is not set' };
    return { available: true };
  }
}
