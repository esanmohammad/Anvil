/**
 * symbol-check — verifies that a finding's `targetSymbol` actually exists in
 * the referenced file or, if absent, in sibling files up to 3 directories up.
 */
import type { EnrichedFinding } from '../review-finding-extensions.js';
export interface SymbolCheckResult {
    passed: boolean;
    detail?: string;
}
/**
 * If `targetSymbol` is absent, the check is skipped (passed = true). Otherwise:
 *  - Look in `fileContent` first.
 *  - If not found, walk sibling directories up to 3 levels up from the file's
 *    dir (resolved against `repoLocalPath`).
 *  - Returns `passed: false` if the symbol could not be located anywhere.
 */
export declare function checkSymbolExists(finding: EnrichedFinding, repoLocalPath: string, fileContent: string): SymbolCheckResult;
//# sourceMappingURL=symbol-check.d.ts.map