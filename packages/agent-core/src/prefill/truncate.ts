/**
 * §2.3.3 context-window truncation policy.
 *
 * `prefill.text` (the partial assistant continuation) plus the recorded
 * tool history may push the resuming request over the TARGET model's
 * input window even though it fit on the source model. Before the chain
 * walker hands a prefill to the next attempt, it runs this gate:
 *
 *   budget = target.maxInputTokens − margin(8K) − baseTokens
 *            − sourceTokens − sum(toolUseTokens)
 *
 *   1. If the partial text alone won't fit (budget-before-tools < 0),
 *      the prefill CANNOT be served → return undefined. The walker then
 *      retries the next model WITHOUT a prefill (a clean re-run beats a
 *      failed run, per §2.3.3 step 3).
 *   2. Otherwise drop the OLDEST tool_use/result pairs (from the start)
 *      until the tool history fits, preserving the most-recent tools and
 *      the trailing partial text. Those dropped tools already executed on
 *      the source model; the resuming model simply won't see them in its
 *      re-presented history.
 *
 * `maxInputTokens` comes from `cost.ts`'s model-prices table; a model
 * missing from the table conservatively assumes 32K (§2.3.3 step 4).
 *
 * Token counts are estimates (default ~chars/4) — exact tokenization is
 * deferred (§ ADR open question). The 8K margin absorbs the slack; if the
 * estimate is too aggressive the walker just drops an extra tool pair,
 * which is a slower chain walk, not a correctness loss.
 */

import { getDetailedPricing } from '../cost.js';
import type { Prefill } from '../turn-recorder/types.js';

/** Conservative floor when the model is absent from the price table. */
export const DEFAULT_MAX_INPUT_TOKENS = 32_000;
/** Headroom reserved below the model's max input window. */
export const DEFAULT_MARGIN_TOKENS = 8_000;

export interface TruncatePrefillArgs {
  prefill: Prefill;
  /** Model id the prefill is about to be served to. */
  targetModel: string;
  /**
   * Tokens already committed to the request before the prefill is
   * spliced (system prompt + the user turn). Best-effort; default 0.
   * Counted against the budget so a large system prompt + big prefill
   * don't silently blow the window.
   */
  baseTokens?: number;
  /** Headroom under the model's max input window. Default 8000. */
  marginTokens?: number;
  /** Estimator over an arbitrary string. Default ≈ chars/4. */
  estimateTokens?: (text: string) => number;
  /**
   * Override the target's max-input-token lookup (tests / models the
   * cost table can't price). Default reads `cost.ts`.
   */
  maxInputTokensFor?: (model: string) => number | undefined;
}

const defaultEstimate = (text: string): number => Math.ceil(text.length / 4);

/** Rough token cost of re-presenting one recorded tool_use/result pair. */
function toolUseTokens(
  tu: Prefill['toolUses'][number],
  estimate: (t: string) => number,
): number {
  const content = typeof tu.result?.content === 'string'
    ? tu.result.content
    : JSON.stringify(tu.result?.content ?? '');
  return estimate(`${tu.name}${JSON.stringify(tu.input ?? {})}${content}`);
}

/**
 * Returns the (possibly tool-trimmed) prefill that fits the target
 * model's input budget, or `undefined` when even the bare partial text
 * won't fit — signalling the walker to retry without a prefill.
 */
export function truncatePrefillForBudget(args: TruncatePrefillArgs): Prefill | undefined {
  const estimate = args.estimateTokens ?? defaultEstimate;
  const margin = args.marginTokens ?? DEFAULT_MARGIN_TOKENS;
  const baseTokens = args.baseTokens ?? 0;

  const maxInput = (args.maxInputTokensFor
    ? args.maxInputTokensFor(args.targetModel)
    : getDetailedPricing(args.targetModel)?.maxInputTokens)
    ?? DEFAULT_MAX_INPUT_TOKENS;

  // Budget remaining for the tool history AFTER the fixed costs (system +
  // user + margin + the partial-text reinjection). If this is already
  // negative the partial alone overflows the window → cannot serve.
  const budgetForTools = maxInput - margin - baseTokens - args.prefill.sourceTokens;
  if (budgetForTools < 0) return undefined;

  // Per-tool token estimates, oldest-first (prefill.toolUses preserves
  // recording order). Drop from the FRONT until the sum fits.
  const tools = args.prefill.toolUses.slice();
  let toolSum = tools.reduce((acc, tu) => acc + toolUseTokens(tu, estimate), 0);

  if (toolSum <= budgetForTools) {
    return args.prefill; // fits as-is
  }

  while (tools.length > 0 && toolSum > budgetForTools) {
    const dropped = tools.shift()!;
    toolSum -= toolUseTokens(dropped, estimate);
  }

  // budgetForTools >= 0 guarantees the empty-tools case fits; return the
  // trimmed prefill (which may have zero tools but always keeps the text).
  return { ...args.prefill, toolUses: tools };
}
