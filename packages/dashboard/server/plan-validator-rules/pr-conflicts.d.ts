/**
 * PR conflicts rule — flags plans that touch files currently being modified in
 * open PRs. Uses the `gh` CLI; silent + cache-friendly to avoid rate limits.
 */
import type { Plan } from '../plan-store.js';
import type { PlanIssue } from '../plan-validator.js';
export interface PRConflictRuleDeps {
    /** Map from repo name (as referenced in the plan) to GitHub owner/repo. */
    githubByRepoName: Record<string, string>;
}
/**
 * Returns warnings for every overlap between plan-claimed files and open-PR
 * files, one issue per conflicting PR × repo.
 */
export declare function checkPrConflicts(plan: Plan, deps: PRConflictRuleDeps): PlanIssue[];
export declare function invalidatePrConflictCache(): void;
//# sourceMappingURL=pr-conflicts.d.ts.map