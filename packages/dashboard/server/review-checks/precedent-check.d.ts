/**
 * precedent-check — for "unusual-pattern" claims, grep the repo for the same
 * quoted pattern. If many precedents exist, the finding is dropped because the
 * pattern is actually established convention.
 */
import type { EnrichedFinding } from '../review-finding-extensions.js';
export interface PrecedentCheckOptions {
    minPrecedents?: number;
}
export interface PrecedentCheckResult {
    passed: boolean;
    detail?: string;
}
/**
 * For `claimType === 'unusual-pattern'`: scans the repo for the finding's
 * `quoted` text. If ≥ `minPrecedents` (default 3) matches are found, the
 * check fails (i.e. finding is to be dropped as the pattern is not unusual).
 */
export declare function checkPrecedent(finding: EnrichedFinding, repoLocalPath: string, opts?: PrecedentCheckOptions): PrecedentCheckResult;
//# sourceMappingURL=precedent-check.d.ts.map