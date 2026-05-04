/**
 * Convention rules prepass — matches added diff lines against the
 * project's `enforced` convention rules stored in
 * `~/.anvil/projects/<project>/conventions.json`.
 *
 * Only `enforced` rules are considered (others are noisy suggestions).
 * Matching is case-insensitive substring against `avoidPattern`. Each
 * hit emits a ReviewFinding with category:'convention' / persona:'style'.
 *
 * OWASP mapping: N/A — these are style/correctness conventions, not
 * security controls.
 */
import { type DiffInput, type ReviewFinding } from './helpers.js';
export interface ConventionRule {
    id: string;
    description: string;
    /** Optional explicit severity. Defaults to 'warn'. */
    severity?: 'blocker' | 'error' | 'warn' | 'info' | 'nit';
    status?: 'detected' | 'validated' | 'enforced';
    /** Optional per-repo scoping — when set, rule only applies to files in this repo. */
    repo?: string;
    /** Free-text hint the added line must NOT contain (case-insensitive substring). */
    avoidPattern?: string;
}
export interface ConventionRulesDeps {
    anvilHome: string;
    project: string;
    /**
     * Optional helper that maps a repo-relative file path to the repo name.
     * Used to scope repo-specific rules. Returning null means "unknown" —
     * such rules will still match (fail open on scoping uncertainty).
     */
    repoByFile?: (filePath: string) => string | null;
}
export declare function runConventionRules(diff: DiffInput, deps: ConventionRulesDeps): ReviewFinding[];
//# sourceMappingURL=conventions.d.ts.map