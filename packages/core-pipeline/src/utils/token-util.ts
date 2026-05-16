/**
 * Provider-agnostic token counter.
 *
 * Single seam every consumer routes through to ask "how many tokens is
 * this string?" Implementations prefer the active adapter's tokenizer
 * (real provider-aware count); when no adapter is in scope, fall back
 * to the chars/4 heuristic that historical code used.
 *
 * Do NOT replicate `Math.ceil(text.length / 4)` in caller code. Always
 * go through `countTokens` so future tokenizer upgrades take effect
 * everywhere.
 *
 * Phase D3 — promoted from dashboard/server/token-util.ts so cli +
 * dashboard share the same heuristic. Behavior identical.
 */

import type { PromptAwareAdapter } from '@esankhan3/anvil-agent-core';

const HEURISTIC_DIVISOR = 4;

/** Heuristic fallback used when no adapter is available. */
export function heuristicTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / HEURISTIC_DIVISOR);
}

/**
 * Same heuristic but applied to a pre-computed UTF-8 byte length —
 * used by prompt-budget consumers that already account in bytes.
 * Equivalent to `heuristicTokenCount` for ASCII; safer for multi-byte
 * input.
 */
export function heuristicTokenCountFromBytes(byteLen: number): number {
  if (!byteLen || byteLen <= 0) return 0;
  return Math.ceil(byteLen / HEURISTIC_DIVISOR);
}

/**
 * Count tokens, preferring the active adapter's tokenizer. `adapter`
 * may be null/undefined for callers that run outside agent execution
 * (e.g., KB indexing utilities).
 */
export function countTokens(
  adapter: PromptAwareAdapter | null | undefined,
  text: string,
): number {
  if (adapter) return adapter.countTokens(text);
  return heuristicTokenCount(text);
}
