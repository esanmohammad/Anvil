/**
 * test-exists-check — for "missing-test" claims, scan the repo for test files
 * that mention the target symbol. If any exist, the finding is a false alarm.
 */
import type { EnrichedFinding } from '../review-finding-extensions.js';
export interface TestExistsCheckResult {
    passed: boolean;
    detail?: string;
}
/**
 * Drops missing-test findings when any test file either has the target symbol
 * in its filename or mentions it in its body.
 */
export declare function checkTestExists(finding: EnrichedFinding, repoLocalPath: string): TestExistsCheckResult;
//# sourceMappingURL=test-exists-check.d.ts.map