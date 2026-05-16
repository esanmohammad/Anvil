/**
 * Verification-engine types — `Issue`, `RuleContext`, `PlanRule`.
 *
 * Every rule in `plan/rules/` is a pure function `(plan, ctx) =>
 * Issue[]`. Zero LLM calls; verifier runs in ms; output is consumed
 * by `run-rules.ts` and surfaced to the UI as inline error markers.
 */

import type { Plan } from '../utils/plan-types.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface Issue {
  /**
   * Stable id of the rule that fired — e.g. `'KB.repo-exists'`. Used
   * by the UI to dedupe + display + auto-fix dispatch.
   */
  ruleId: string;
  severity: IssueSeverity;
  /** JSON-path into the plan, e.g. `repos[1].mustTouch[3].path`. */
  path: string;
  message: string;
  /**
   * Hint for the user OR for the same-agent corrective regen. Structured
   * suggestions (`{ kind: 'set-field', path, value }`) live in
   * `autoFixSuggestion`; this string is the free-form fallback.
   */
  fixHint?: string;
  /**
   * If the engine can patch the plan deterministically without an LLM
   * (e.g. add a missing `parentVersion: null`), this flag tells the
   * REFINE phase to apply the patch silently.
   */
  autoFixable: boolean;
  /**
   * Structured auto-fix payload — present when `autoFixable: true`.
   * The auto-refine engine applies these in order before re-validating.
   */
  autoFixSuggestion?: AutoFixSuggestion;
}

export type AutoFixSuggestion =
  /** `plan[path] = value` */
  | { kind: 'set-field'; path: string; value: unknown }
  /** Push `value` onto an array at `path`. */
  | { kind: 'push-to-array'; path: string; value: unknown }
  /** Remove the array element / map key at `path`. */
  | { kind: 'remove-field'; path: string };

/**
 * Read-only context handed to each rule. Rules MUST NOT mutate it.
 * Heavy dependencies (project loader, KB index reads) are caller-supplied
 * — rules consume them via narrow function shapes so unit tests can
 * inject fakes without dragging in the project-loader machinery.
 */
export interface RuleContext {
  /** Project name. Used for KB lookups + project-config reads. */
  project: string;
  /**
   * Repos registered in the project's `factory.yaml`. KB.repo-exists
   * uses this list to flag plan repos that aren't in the project.
   */
  projectRepos: string[];
  /**
   * Per-repo KB index: repo name → set of file paths the KB knows
   * about. Empty Set means the KB is absent for that repo (rule
   * downgrades to `info` severity). Caller is responsible for
   * indexing; rules just read.
   */
  kbFiles: Record<string, Set<string>>;
  /**
   * Per-repo KB symbol index: repo name → set of symbol names. Same
   * absent-KB semantics as `kbFiles`.
   */
  kbSymbols: Record<string, Set<string>>;
  /**
   * Caller-supplied calibration anchors for budget rules.
   * `medianUsdPerSimilarPlan` is null when there are no learnings yet.
   */
  budget?: {
    medianUsdPerSimilarPlan: number | null;
    /** Hard cost cap from the user's policy file (or the built-in default). */
    maxPerRunUsd?: number;
  };
}

export type PlanRule = (plan: Plan, ctx: RuleContext) => Issue[];

/** Helper: build a single-issue list shorthand for trivial rules. */
export function singleIssue(issue: Issue): Issue[] {
  return [issue];
}
