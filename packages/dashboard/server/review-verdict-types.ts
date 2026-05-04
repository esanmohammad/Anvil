/**
 * Review Phase R9 — Verdict types.
 *
 * A single-verdict summary produced from the filtered `ReviewFinding[]` after
 * all other review phases have run (evidence gate, calibration, plan-aware
 * drift, scope matching, security pre-pass, etc.). The verdict collapses all
 * of those signals into one of three user-facing levels and the materials
 * needed to render a banner + disclosure in the UI.
 *
 * Kept intentionally free of a direct dependency on the `ReviewFinding` type
 * (findings are typed as `unknown[]` at the module boundary) so this file can
 * sit alongside other review modules without forcing re-exports.
 */

/** Coarse verdict level surfaced on the Review page. */
export type VerdictLevel = 'approve' | 'needs-changes' | 'blocker';

/**
 * Result of synthesizing a single verdict from a list of filtered findings.
 *
 * `blockers`, `mainFindings`, and `polish` are intentionally typed as
 * `unknown[]` — the synthesizer treats findings structurally and the UI
 * consumes them through small render adapters.
 */
export interface ReviewVerdict {
  /** The single verdict level shown at the top of the Review page. */
  level: VerdictLevel;
  /** Short, user-facing sentence used as the banner headline. */
  headline: string;
  /** Findings that triggered the blocker level (severity=blocker or immutable). */
  blockers: unknown[];
  /** Top 3-5 findings displayed under `needs-changes`, sorted by priority. */
  mainFindings: unknown[];
  /** Demoted / low-severity findings, collapsed behind a disclosure. */
  polish: unknown[];
  /** ISO 8601 timestamp at which the verdict was computed. */
  computedAt: string;
  /** Count of findings marked `immutable: true` (e.g. regression-guard bindings). */
  immutableBlockerCount: number;
  /** Aggregate counts used by the banner subline. */
  summary: {
    totalFindings: number;
    bySeverity: Record<string, number>; // keys include 'blocker' | 'high' | 'medium' | 'low' | 'info'
    byPersona: Record<string, number>;
  };
}
