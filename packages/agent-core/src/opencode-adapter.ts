/**
 * OpenCode Go adapter — agentic HTTPS proxy for OpenCode's subscription
 * service (https://opencode.ai/docs/go).
 *
 * OpenCode Go is a $10/month subscription that exposes a curated set of
 * open coding models (Qwen3.5/3.6 Plus, Kimi K2.5/K2.6, GLM-5/5.1,
 * DeepSeek V4, MiniMax M2.5/M2.7, MiMo …) via an OpenAI-compatible API
 * at `https://opencode.ai/zen/go/v1/`. From our perspective it's just
 * another OpenAI-compatible endpoint — same SSE format, same tool-call
 * delta protocol — so we inherit `OpenRouterAdapter`'s agentic loop
 * and override the config.
 *
 * Models in the registry are addressed as `opencode/<model>` (e.g.
 * `opencode/qwen3.5-plus`). The adapter strips the `opencode/` prefix
 * before sending to the upstream API. No binary, no daemon, no local
 * SDK — just HTTP + an API key from the user's Go subscription.
 *
 * Replaces Ollama as the cheap local-tier provider when the user has
 * a Go subscription: VRAM cost drops from ~12 GB (Ollama hosting
 * qwen3:14b) to 0 GB, RAM cost stays nominal. Inference happens on
 * OpenCode's hosted infrastructure.
 */

import type { ModelAdapterConfig, ModelAdapterResult, ProviderName } from './types.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';

const PREFIX = 'opencode/';

/**
 * Pricing fallbacks for known OpenCode Go models. The proxy also
 * returns `usage.cost` directly (mirrors OpenRouter's behavior); when
 * present the inherited base class prefers that over this table. These
 * entries are for the offline path / cost estimates before a call
 * runs. Pricing reflects model-card list rates as of 2026-05.
 */
const OPENCODE_GO_PRICING: Record<string, [number, number]> = {
  // GLM family
  'glm-5':            [0.50, 2.00],
  'glm-5.1':          [0.60, 2.40],
  // Kimi family
  'kimi-k2.5':        [0.30, 1.20],
  'kimi-k2.6':        [0.50, 2.00],
  // MiMo
  'mimo-v2-pro':      [0.40, 1.60],
  'mimo-v2-omni':     [0.20, 0.80],
  'mimo-v2.5-pro':    [0.40, 1.60],
  'mimo-v2.5':        [0.20, 0.80],
  // MiniMax
  'minimax-m2.5':     [0.10, 0.40],
  'minimax-m2.7':     [0.20, 0.80],
  // Qwen
  'qwen3.5-plus':     [0.05, 0.20],
  'qwen3.6-plus':     [0.20, 0.80],
  // DeepSeek
  'deepseek-v4-pro':  [0.20, 0.80],
  'deepseek-v4-flash':[0.02, 0.08],
};

export class OpenCodeAdapter extends OpenRouterAdapter {
  override readonly provider: ProviderName = 'opencode';

  // -- Configuration overrides ----------------------------------------------

  protected override getApiKey(): string | undefined {
    return process.env.OPENCODE_API_KEY;
  }

  protected override getBaseUrl(): string {
    // Default endpoint per https://opencode.ai/docs/go. Allow override
    // via OPENCODE_BASE_URL so users on different regions or testing
    // against a local opencode serve instance can redirect.
    return (process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
  }

  protected override getExtraHeaders(): Record<string, string> {
    return {
      // X-Title shows up in OpenCode's usage console; HTTP-Referer is
      // OpenRouter-specific and not required here.
      'X-Title': 'Anvil',
    };
  }

  /**
   * OpenCode's proxy strictly validates assistant message shape and
   * rejects `reasoning` / `reasoning_details` with
   * `invalid_request_error: Extra inputs are not permitted, field:
   * 'messages[N].reasoning(_details)'` (observed on Kimi K2.6,
   * confirmed by anomalyco/opencode #14716 — "OpenCode should not
   * include reasoning metadata in subsequent message transmissions").
   * The proxy handles reasoning internally; the client should send
   * the standard OpenAI-compat shape without sibling fields.
   */
  protected override stripReasoningEcho(): boolean {
    return true;
  }

  // -- Model id handling ----------------------------------------------------

  override supportsModel(modelId: string): boolean {
    // Registry uses the `opencode/` prefix to disambiguate from
    // OpenRouter's `<provider>/<model>` slugs (which pass the same
    // `includes('/')` test the parent uses).
    return modelId.startsWith(PREFIX);
  }

  override getModelPricing(modelId: string): [number, number] | null {
    const stripped = modelId.startsWith(PREFIX) ? modelId.slice(PREFIX.length) : modelId;
    return OPENCODE_GO_PRICING[stripped] ?? null;
  }

  // -- Run override: strip prefix before calling upstream -------------------

  override async run(
    config: ModelAdapterConfig,
    output: NodeJS.WritableStream,
  ): Promise<ModelAdapterResult> {
    if (!config.model.startsWith(PREFIX)) {
      // Safety net — caller should always send a properly-prefixed id,
      // but if they don't we tolerate it rather than 500'ing.
      return super.run(config, output);
    }
    const upstreamModel = config.model.slice(PREFIX.length);
    const result = await super.run({ ...config, model: upstreamModel }, output);
    // Re-stamp the result with our prefixed id so downstream telemetry
    // attributes the call to the OpenCode adapter, not OpenRouter.
    return { ...result, provider: this.provider, model: config.model };
  }

  // -- Availability ---------------------------------------------------------

  override async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const key = this.getApiKey();
    if (!key) return { available: false, error: 'OPENCODE_API_KEY is not set (subscribe at https://opencode.ai/zen)' };
    return { available: true };
  }
}
