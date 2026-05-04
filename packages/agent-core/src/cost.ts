/**
 * Central cost calculator — backed by a vendored snapshot of LiteLLM's
 * `model_prices_and_context_window.json` (Apache-2.0).
 *
 * The snapshot lives at `data/model-prices.json` (committed). Refresh via
 * `node scripts/refresh-cost-table.mjs` (quarterly + on adding new models).
 *
 * LiteLLM's keys use full versioned model IDs (e.g. `claude-3-5-sonnet-20241022`).
 * Anvil's adapter PRICING tables historically use short canonical names
 * (`sonnet`, `opus`, `haiku`). The `MODEL_ALIASES` table below bridges the
 * two — short name → LiteLLM key. When the loader fails on the literal model
 * ID, it falls back to the alias table.
 *
 * Pricing units in this module:
 *   input_cost_per_token / output_cost_per_token from LiteLLM are PER-TOKEN.
 *   We convert to PER-1M-TOKENS to match the existing ModelAdapter contract
 *   (`getModelPricing(modelId): [number, number] | null` where the tuple is
 *   `[inputPer1M, outputPer1M]`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── JSON snapshot loader ──────────────────────────────────────────────────

interface LiteLLMPriceEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PRICES_PATH = join(__dirname, 'data', 'model-prices.json');

let _modelPrices: Record<string, LiteLLMPriceEntry> | null = null;

function loadModelPrices(): Record<string, LiteLLMPriceEntry> {
  if (_modelPrices) return _modelPrices;
  try {
    _modelPrices = JSON.parse(readFileSync(PRICES_PATH, 'utf-8')) as Record<string, LiteLLMPriceEntry>;
  } catch (err) {
    process.stderr.write(
      `[anvil-cost] WARNING: failed to load model-prices.json from ${PRICES_PATH}: ` +
      `${(err as Error).message}. Cost calculations will return 0.\n`,
    );
    _modelPrices = {};
  }
  return _modelPrices;
}

// ── Anvil short-name → LiteLLM canonical-name aliases ─────────────────────

/**
 * Bridge table — maps Anvil's short canonical model names (used in
 * `model-router.ts` and adapter PRICING tables) to specific LiteLLM keys.
 * Conservative: each short name resolves to a stable, recent flagship version.
 * Refresh in lockstep with the cost-table snapshot when new flagships ship.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Anthropic short names
  'sonnet':            'claude-sonnet-4-6',
  'opus':              'claude-opus-4-7',
  'haiku':             'claude-haiku-4-5',
  'claude-sonnet-4':   'claude-sonnet-4-6',
  'claude-opus-4':     'claude-opus-4-7',
  'claude-haiku-4':    'claude-haiku-4-5',
};

// ── Lookup ────────────────────────────────────────────────────────────────

/**
 * Look up a model in the cost table.
 *
 * @returns `[inputPer1M, outputPer1M]` in USD, or `null` if the model is
 *   unknown. Cache pricing is intentionally NOT exposed via this surface —
 *   use `getDetailedPricing` for that.
 */
export function getModelPricing(model: string): [number, number] | null {
  const entry = lookupEntry(model);
  if (!entry || typeof entry.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') {
    return null;
  }
  return [entry.input_cost_per_token * 1_000_000, entry.output_cost_per_token * 1_000_000];
}

export interface DetailedPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** Detailed pricing including cache columns + context-window limits. */
export function getDetailedPricing(model: string): DetailedPricing | null {
  const entry = lookupEntry(model);
  if (!entry || typeof entry.input_cost_per_token !== 'number' || typeof entry.output_cost_per_token !== 'number') {
    return null;
  }
  return {
    inputPer1M: entry.input_cost_per_token * 1_000_000,
    outputPer1M: entry.output_cost_per_token * 1_000_000,
    cacheReadPer1M: entry.cache_read_input_token_cost !== undefined
      ? entry.cache_read_input_token_cost * 1_000_000
      : undefined,
    cacheWritePer1M: entry.cache_creation_input_token_cost !== undefined
      ? entry.cache_creation_input_token_cost * 1_000_000
      : undefined,
    maxInputTokens: entry.max_input_tokens,
    maxOutputTokens: entry.max_output_tokens,
  };
}

function lookupEntry(model: string): LiteLLMPriceEntry | undefined {
  const prices = loadModelPrices();
  // 1. Exact match.
  if (prices[model]) return prices[model];
  // 2. Alias bridge.
  const aliased = MODEL_ALIASES[model.toLowerCase()];
  if (aliased && prices[aliased]) return prices[aliased];
  // 3. Substring match — for short names that didn't make it into MODEL_ALIASES.
  //    Iterate aliases first (cheap, small set), then bail.
  const lower = model.toLowerCase();
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (lower.includes(alias) && prices[target]) return prices[target];
  }
  return undefined;
}

// ── Cost calculation ──────────────────────────────────────────────────────

export interface UsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  totalUsd: number;
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
}

/**
 * Compute a per-component cost breakdown.
 *
 * Returns all-zero values when the model isn't in the cost table — caller
 * decides whether to fall back to an adapter-supplied cost (the existing
 * legacy path). Cache components are zero when either the usage doesn't
 * include cache tokens or the pricing entry doesn't list a cache rate.
 */
export function calculateCostBreakdown(model: string, usage: UsageInput): CostBreakdown {
  const p = getDetailedPricing(model);
  if (!p) {
    return { totalUsd: 0, inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0 };
  }
  const inputUsd = (usage.inputTokens / 1_000_000) * p.inputPer1M;
  const outputUsd = (usage.outputTokens / 1_000_000) * p.outputPer1M;
  const cacheReadUsd = usage.cacheReadTokens && p.cacheReadPer1M
    ? (usage.cacheReadTokens / 1_000_000) * p.cacheReadPer1M
    : 0;
  const cacheWriteUsd = usage.cacheWriteTokens && p.cacheWritePer1M
    ? (usage.cacheWriteTokens / 1_000_000) * p.cacheWritePer1M
    : 0;
  return {
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
  };
}

/**
 * Compute USD cost for a usage block at the given model's pricing.
 * Returns 0 if the model is unknown.
 */
export function calculateCost(model: string, usage: UsageInput): number {
  return calculateCostBreakdown(model, usage).totalUsd;
}

/** Test seam — clear the in-memory cache. */
export function resetCostTable(): void {
  _modelPrices = null;
}
