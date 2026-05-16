/**
 * Pure JSON-extraction helpers (Phase 3 extraction from
 * `dashboard-server.ts`). Zero closure deps.
 *
 *   - `extractJsonBlock(text)` — multi-strategy JSON extraction over
 *     streamed LLM output. Used by every plan agent finalisation.
 *   - `largestBalancedSpan(text, open, close)` — find the widest
 *     balanced span (skipping string contents).
 *   - `extractJsonBlockFromText(text)` — simpler regex/heuristic
 *     variant used by the review agent finaliser.
 *   - `isValidParsedShape(parsed, section)` — gate the dispatch path
 *     against section-specific shape expectations.
 *   - `buildJsonCorrectionInput(badOutput, section)` — corrective
 *     prompt for the same-agent JSON-recovery turn.
 */
import type { PlanSection } from '../plan-store.js';
/**
 * Extract JSON from streamed agent output. Tries (in order):
 *   1. Direct parse of the trimmed output.
 *   2. Every fenced ```json / ``` block, longest first.
 *   3. Largest balanced `{...}` slice.
 *   4. Largest balanced `[...]` slice (for section regen of repos /
 *      contracts / risks where the section is an array).
 *   5. Same passes after stripping trailing commas, JS-style comments,
 *      smart quotes — common LLM artifacts that break strict JSON.parse.
 * Returns `unknown` (object / array / primitive parsed from JSON), or
 * `null` when every strategy fails.
 */
export declare function extractJsonBlock(text: string): unknown | null;
/**
 * Walk the string finding the widest balanced span between `open` and
 * `close`. String contents (including escaped quotes) are skipped so
 * braces inside strings don't break balance counting.
 */
export declare function largestBalancedSpan(text: string, open: string, close: string): string | null;
/** Simpler regex/heuristic JSON extractor used by the review finaliser. */
export declare function extractJsonBlockFromText(text: string): unknown | null;
/**
 * Validate the shape the model returned matches what the dispatch path
 * expects. Section `problem` is a plain string; every other section is
 * an object or array — `typeof === 'object'` covers both since arrays
 * are objects in JS.
 */
export declare function isValidParsedShape(parsed: unknown, section?: PlanSection): boolean;
/**
 * Build the corrective input sent to the SAME agent when its first
 * output didn't parse. Quoting the bad output (truncated) helps the
 * model see what it actually emitted.
 */
export declare function buildJsonCorrectionInput(badOutput: string, section?: PlanSection): string;
//# sourceMappingURL=json-extract.d.ts.map