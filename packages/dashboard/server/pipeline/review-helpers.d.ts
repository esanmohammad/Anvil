/**
 * Pure review-spawn helpers (Phase 3 extraction from
 * `dashboard-server.ts`). Zero closure deps.
 *
 *   - `loadPrDiff(repo, prNumber)` — call `gh api`/`gh pr diff` and
 *     parse the unified diff into per-file added-lines.
 *   - `buildReviewerPrompt(persona, review, diff, plan, learnings)` —
 *     persona-specific prompt template.
 *   - `normaliseFinding(partial)` — fill defaults for the
 *     `ReviewFinding` shape coming back from the model.
 *   - `severityToAnnotation(s)` — map ReviewFinding severity onto the
 *     annotator's narrower severity ladder.
 */
import { type Review, type ReviewFinding, type Persona, type Severity, type Category } from '../review-store.js';
import type { Plan } from '../plan-store.js';
/** Load diff lines from gh CLI — input for the security + convention rules. */
export declare function loadPrDiff(repo: string, prNumber: number): Promise<{
    diff: string;
    files: Array<{
        path: string;
        addedLines: Array<{
            lineNumber: number;
            text: string;
        }>;
    }>;
    additions: number;
    deletions: number;
    fileCount: number;
    headSha: string;
    baseSha: string;
    title?: string;
    author?: string;
}>;
export declare function buildReviewerPrompt(persona: Persona, review: Review, diff: string, plan: Plan | null, learnings: string): string;
/** Fill defaults for the ReviewFinding shape coming back from the model. */
export declare function normaliseFinding(partial: Partial<ReviewFinding> & {
    severity: Severity;
    category: Category;
    file: string;
    line: number;
    snippet: string;
    description: string;
}): ReviewFinding;
/** Map ReviewFinding severity onto the annotator's narrower ladder. */
export declare function severityToAnnotation(s: Severity): 'blocker' | 'high' | 'medium' | 'low' | 'info';
//# sourceMappingURL=review-helpers.d.ts.map