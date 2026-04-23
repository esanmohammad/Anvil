/**
 * Shared helpers for review prepass rules.
 *
 * Pure functions only — no I/O. These helpers are used by both
 * security-prepass.ts and conventions.ts to walk added diff lines and
 * build standard ReviewFinding shapes.
 */
export interface DiffAddedLine {
    lineNumber: number;
    text: string;
}
export interface DiffFile {
    path: string;
    /** The +added lines only, with 1-based line numbers in the NEW file. */
    addedLines: DiffAddedLine[];
}
export interface DiffInput {
    files: DiffFile[];
}
export interface ReviewFindingSuggestedFix {
    diff: string;
    rationale: string;
}
export interface ReviewFinding {
    severity: 'blocker' | 'error' | 'warn' | 'info' | 'nit';
    category: 'correctness' | 'security' | 'convention' | 'test' | 'perf' | 'docs' | 'plan-drift';
    persona?: 'architect' | 'security' | 'style' | 'tester' | 'domain';
    file: string;
    line: number;
    snippet: string;
    description: string;
    suggestedFix?: ReviewFindingSuggestedFix;
    confidence?: 'high' | 'med' | 'low';
    cve?: string;
    resolution?: 'pending';
}
/**
 * Trim a text chunk to a short, single-line-ish snippet for findings.
 * Removes trailing newlines and limits to 160 chars.
 */
export declare function snippet(text: string): string;
export interface MatchHit {
    file: string;
    lineNumber: number;
    text: string;
    match: RegExpExecArray;
}
/**
 * Iterate added lines across all files, yielding every regex match.
 * For each line we exec() the regex until exhausted so multi-hit lines
 * (e.g. two secrets pasted together) are not silently collapsed.
 *
 * The regex is cloned per call so accumulated lastIndex on a /g regex
 * passed in from the caller doesn't leak across matchers.
 */
export declare function matchInAddedLines(diff: DiffInput, regex: RegExp): Generator<MatchHit>;
/**
 * Build a suggestedFix that replaces a literal secret with an env var ref.
 * The diff is a small, human-readable unified-ish hunk (not strict patch
 * format — the reviewer UI renders this as a hint, not an apply-able patch).
 */
export declare function envVarFix(match: string, varName: string): ReviewFindingSuggestedFix;
//# sourceMappingURL=helpers.d.ts.map