/**
 * Cost pricing table — USD per **million** tokens.
 *
 * Numbers reflect Anthropic's public list pricing at time of writing. They
 * are hard-coded here (rather than fetched) so that:
 *  - pricing is deterministic in tests,
 *  - cost estimates never depend on a network call,
 *  - updates happen via a single, reviewed PR.
 *
 * When a request arrives for an unknown model id we fall back to Sonnet
 * pricing and log a one-time warning. This errs on the safe side: Sonnet
 * is mid-tier, so unknown models are neither under- nor over-charged by
 * orders of magnitude.
 */

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  inPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outPerMTok: number;
}

// ── Pricing table ────────────────────────────────────────────────────────

const PRICING: Record<string, ModelPrice> = {
  // Opus-class — highest quality, highest cost.
  'claude-opus-4-7': { inPerMTok: 15, outPerMTok: 75 },
  'claude-opus-4-5': { inPerMTok: 15, outPerMTok: 75 },

  // Sonnet-class — default fallback.
  'claude-sonnet-4-6': { inPerMTok: 3, outPerMTok: 15 },
  'claude-sonnet-4-5': { inPerMTok: 3, outPerMTok: 15 },

  // Haiku-class — cheapest.
  'claude-haiku-4-5-20251001': { inPerMTok: 1, outPerMTok: 5 },
  'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 },
};

const FALLBACK_MODEL_ID = 'claude-sonnet-4-6';
const FALLBACK_PRICE: ModelPrice = PRICING[FALLBACK_MODEL_ID]!;

// Remember which unknown models we've already warned about so we don't spam
// the log on every LLM call.
const warnedUnknownModels = new Set<string>();

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Compute USD cost for a single LLM call. Always positive, rounded to 6
 * decimal places. Negative or non-finite token counts are clamped to 0.
 */
export function priceUsd(model: string, tokensIn: number, tokensOut: number): number {
  const price = PRICING[model];
  if (!price) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      // eslint-disable-next-line no-console
      console.warn(
        `[cost-pricing] Unknown model "${model}" — defaulting to ${FALLBACK_MODEL_ID} pricing.`,
      );
    }
  }
  const effective = price ?? FALLBACK_PRICE;
  const safeIn = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const safeOut = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  const usd = (safeIn / 1_000_000) * effective.inPerMTok
    + (safeOut / 1_000_000) * effective.outPerMTok;
  return round6(usd);
}

/** List all known models with their pricing (used for `anvil cost prices`). */
export function listPricing(): Array<{ model: string; inPerMTok: number; outPerMTok: number }> {
  return Object.entries(PRICING).map(([model, p]) => ({
    model,
    inPerMTok: p.inPerMTok,
    outPerMTok: p.outPerMTok,
  }));
}

/** Exposed for tests — resets the "already warned" set. */
export function __resetWarnedForTests(): void {
  warnedUnknownModels.clear();
}
