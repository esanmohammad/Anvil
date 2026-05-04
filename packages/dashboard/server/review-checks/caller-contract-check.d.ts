/**
 * caller-contract-check — for "assumption" claims, verify whether all callers
 * of the target symbol guarantee the assumed precondition. If they do, the
 * finding is dropped (the assumption is safe). Uses an optional AST graph;
 * skips gracefully when one isn't provided.
 */
import type { EnrichedFinding } from '../review-finding-extensions.js';
export interface CallerContractCheckResult {
    passed: boolean;
    detail?: string;
}
/**
 * For `claimType === 'assumption'`: asks the optional astGraph for callers of
 * `finding.targetSymbol`, then checks whether each caller's snippet contains
 * the stated `assumedPrecondition`. If every caller satisfies it, drop the
 * finding. If no graph is provided, skip (pass).
 */
export declare function checkCallerContract(finding: EnrichedFinding, _repoLocalPath: string, astGraph?: unknown): CallerContractCheckResult;
//# sourceMappingURL=caller-contract-check.d.ts.map