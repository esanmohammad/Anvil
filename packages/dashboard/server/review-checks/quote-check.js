/**
 * quote-check — verifies that a finding's `quoted` text literally appears in
 * the diff (whitespace-collapsed). Skipped when `quoted` is absent.
 */
import { normalizeWhitespace } from '../review-finding-extensions.js';
const MAX_PREVIEW = 80;
function preview(text) {
    const one = normalizeWhitespace(text);
    return one.length <= MAX_PREVIEW ? one : `${one.slice(0, MAX_PREVIEW)}...`;
}
/**
 * Passed if `finding.quoted` appears verbatim in `diffText`. Whitespace runs
 * are collapsed on both sides before comparison. If `quoted` is missing or
 * empty, the check is skipped and `passed` is true.
 */
export function checkQuoteInDiff(finding, diffText) {
    const quoted = finding.quoted;
    if (!quoted || quoted.trim().length === 0) {
        return { passed: true, detail: 'skipped: no quoted text on finding' };
    }
    if (typeof diffText !== 'string' || diffText.length === 0) {
        return { passed: false, detail: 'diff text is empty; cannot verify quote' };
    }
    const needleExact = quoted;
    if (diffText.includes(needleExact)) {
        return { passed: true, detail: `exact match: ${preview(needleExact)}` };
    }
    const needleNorm = normalizeWhitespace(quoted);
    const hayNorm = normalizeWhitespace(diffText);
    if (needleNorm.length > 0 && hayNorm.includes(needleNorm)) {
        return {
            passed: true,
            detail: `normalized match: ${preview(needleNorm)}`,
        };
    }
    return {
        passed: false,
        detail: `quoted text not found in diff: ${preview(quoted)}`,
    };
}
//# sourceMappingURL=quote-check.js.map