/**
 * quote-check — verifies that a finding's `quoted` text literally appears in
 * the diff (whitespace-collapsed). Skipped when `quoted` is absent.
 */
import type { EnrichedFinding } from '../review-finding-extensions.js';
export interface QuoteCheckResult {
    passed: boolean;
    detail?: string;
}
/**
 * Passed if `finding.quoted` appears verbatim in `diffText`. Whitespace runs
 * are collapsed on both sides before comparison. If `quoted` is missing or
 * empty, the check is skipped and `passed` is true.
 */
export declare function checkQuoteInDiff(finding: EnrichedFinding, diffText: string): QuoteCheckResult;
//# sourceMappingURL=quote-check.d.ts.map