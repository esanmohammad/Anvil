/**
 * type-check — shells out to the project's type checker (tsc / pyright / mypy /
 * go vet) to validate a null-deref or type-mismatch claim. Degrades silently
 * when the tool isn't installed.
 */
import type { EnrichedFinding } from '../review-finding-extensions.js';
export interface TypeCheckResult {
    passed: boolean;
    detail?: string;
}
/**
 * For null-deref/type-mismatch claims, run the language-appropriate checker
 * and see whether it agrees. Returns `passed: true` (skip) when:
 *  - claim type isn't null-deref/type-mismatch
 *  - the language is unsupported
 *  - the tool is not installed
 */
export declare function checkTypeClaim(finding: EnrichedFinding, repoLocalPath: string, filePath: string): Promise<TypeCheckResult>;
//# sourceMappingURL=type-check.d.ts.map